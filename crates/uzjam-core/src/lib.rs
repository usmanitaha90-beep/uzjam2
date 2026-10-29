use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const PROFILE_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    Peak,
    LowShelf,
    HighShelf,
    LowPass,
    HighPass,
    Notch,
    BandPass,
    AllPass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelMode {
    Stereo,
    Left,
    Right,
}

impl ChannelMode {
    pub fn applies_to_left(self) -> bool {
        matches!(self, Self::Stereo | Self::Left)
    }

    pub fn applies_to_right(self) -> bool {
        matches!(self, Self::Stereo | Self::Right)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqFilter {
    pub id: String,
    pub enabled: bool,
    pub kind: FilterKind,
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q: f64,
    pub channel: ChannelMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeadroomMode {
    Auto,
    Manual,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClippingPolicy {
    Auto,
    Smooth,
    Curve,
    AllowClipping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspSettings {
    pub enabled: bool,
    /// User-authored gain applied before EQ. This is independent of headroom protection.
    pub preamp_db: f64,
    /// Positive attenuation budget used by manual/curve/smooth protection modes.
    #[serde(default)]
    pub manual_headroom_db: f64,
    pub headroom_mode: HeadroomMode,
    pub safety_margin_db: f64,
    pub clipping_policy: ClippingPolicy,
    pub limiter_enabled: bool,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            preamp_db: 0.0,
            manual_headroom_db: 0.0,
            headroom_mode: HeadroomMode::Auto,
            safety_margin_db: 0.3,
            clipping_policy: ClippingPolicy::Auto,
            limiter_enabled: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRef {
    pub id: String,
    pub name: String,
    pub correction_strength: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBinding {
    pub headphone_id: Option<String>,
    pub output_device_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMetadata {
    pub created_at_utc: String,
    pub modified_at_utc: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UzjamProfile {
    pub schema_version: u16,
    pub id: String,
    pub name: String,
    pub filters: Vec<EqFilter>,
    pub dsp: DspSettings,
    pub target: Option<TargetRef>,
    pub device_binding: Option<DeviceBinding>,
    pub metadata: ProfileMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationSeverity {
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub severity: ValidationSeverity,
    pub path: String,
    pub message: String,
}

impl UzjamProfile {
    /// Validate data integrity without imposing arbitrary audiophile limits.
    /// Large finite gain/Q values are allowed; impossible/non-finite values are not.
    pub fn validate(&self) -> Vec<ValidationIssue> {
        let mut issues = Vec::new();

        if self.schema_version != PROFILE_SCHEMA_VERSION {
            issues.push(ValidationIssue {
                severity: ValidationSeverity::Warning,
                path: "schemaVersion".into(),
                message: format!(
                    "profile schema {} differs from engine schema {}",
                    self.schema_version, PROFILE_SCHEMA_VERSION
                ),
            });
        }

        if self.id.trim().is_empty() {
            issues.push(error("id", "profile id cannot be empty"));
        }
        if self.name.trim().is_empty() {
            issues.push(error("name", "profile name cannot be empty"));
        }
        if !self.dsp.preamp_db.is_finite() {
            issues.push(error("dsp.preampDb", "preamp must be finite"));
        }
        if !self.dsp.manual_headroom_db.is_finite() || self.dsp.manual_headroom_db < 0.0 {
            issues.push(error(
                "dsp.manualHeadroomDb",
                "manual headroom must be finite and >= 0 dB",
            ));
        }
        if !self.dsp.safety_margin_db.is_finite() || self.dsp.safety_margin_db < 0.0 {
            issues.push(error(
                "dsp.safetyMarginDb",
                "safety margin must be finite and >= 0 dB",
            ));
        }

        if let Some(target) = &self.target {
            if !target.correction_strength.is_finite() {
                issues.push(error(
                    "target.correctionStrength",
                    "correction strength must be finite",
                ));
            } else if !(0.0..=1.0).contains(&target.correction_strength) {
                issues.push(warning(
                    "target.correctionStrength",
                    "correction strength is normally expressed from 0.0 to 1.0",
                ));
            }
        }

        let mut ids = HashSet::new();
        for (index, filter) in self.filters.iter().enumerate() {
            let base = format!("filters[{index}]");
            if filter.id.trim().is_empty() {
                issues.push(error(format!("{base}.id"), "filter id cannot be empty"));
            } else if !ids.insert(filter.id.clone()) {
                issues.push(error(
                    format!("{base}.id"),
                    "filter ids must be unique inside a profile",
                ));
            }
            if !filter.frequency_hz.is_finite() || filter.frequency_hz <= 0.0 {
                issues.push(error(
                    format!("{base}.frequencyHz"),
                    "frequency must be finite and > 0 Hz",
                ));
            }
            if !filter.gain_db.is_finite() {
                issues.push(error(format!("{base}.gainDb"), "gain must be finite"));
            }
            if !filter.q.is_finite() || filter.q <= 0.0 {
                issues.push(error(format!("{base}.q"), "Q must be finite and > 0"));
            }
        }

        issues
    }
}

fn error(path: impl Into<String>, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: ValidationSeverity::Error,
        path: path.into(),
        message: message.into(),
    }
}

fn warning(path: impl Into<String>, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: ValidationSeverity::Warning,
        path: path.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_allows_large_but_finite_user_values() {
        let profile = UzjamProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            id: "test".into(),
            name: "Test".into(),
            filters: vec![EqFilter {
                id: "f1".into(),
                enabled: true,
                kind: FilterKind::Peak,
                frequency_hz: 1000.0,
                gain_db: 30.0,
                q: 25.0,
                channel: ChannelMode::Stereo,
            }],
            dsp: DspSettings::default(),
            target: None,
            device_binding: None,
            metadata: ProfileMetadata {
                created_at_utc: "2026-10-04T00:00:00Z".into(),
                modified_at_utc: "2026-10-04T00:00:00Z".into(),
                source: None,
            },
        };
        assert!(profile.validate().is_empty());
    }
}
