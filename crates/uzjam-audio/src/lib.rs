//! Portable audio-routing boundary for UZjam.
//!
//! Platform adapters own endpoint discovery, stream timing and error recovery.
//! They deliver interleaved `f32` PCM to an [`AudioProcessor`], which keeps the
//! DSP implementation independent from WASAPI, CoreAudio, AAudio and PipeWire.

use serde::{Deserialize, Serialize};
use std::fmt;

#[cfg(windows)]
pub mod windows;

#[cfg(windows)]
pub use windows::{ExternalPcmInput, WasapiBackend};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Windows,
    Android,
    MacOs,
    Linux,
    Ios,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SupportLevel {
    Supported,
    Partial,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub system_wide_eq: SupportLevel,
    pub exclusive_mode: SupportLevel,
    pub usb_direct: SupportLevel,
    pub app_specific_eq: SupportLevel,
    pub high_resolution_audio: SupportLevel,
    pub device_switching: SupportLevel,
    pub channel_routing: SupportLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceTransport {
    Usb,
    Bluetooth,
    BuiltIn,
    Virtual,
    Hdmi,
    Network,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    /// Stable platform endpoint identifier. It must be persisted instead of the display name.
    pub id: String,
    pub name: String,
    pub manufacturer: Option<String>,
    pub transport: DeviceTransport,
    pub is_default: bool,
    /// Channel count of the endpoint's current shared-mode mix format.
    pub max_channels: u16,
    /// Formats confirmed by the adapter. Adapters must not invent capabilities.
    pub supported_sample_rates: Vec<u32>,
    pub supported_bit_depths: Vec<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioSourceKind {
    /// A physical or virtual recording endpoint.
    Input,
    /// The shared Windows/system mix of a render endpoint.
    SystemLoopback,
    /// PCM supplied by a trusted companion such as the UZjam browser extension.
    ExternalStream,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub id: String,
    pub name: String,
    pub manufacturer: Option<String>,
    pub transport: DeviceTransport,
    pub is_default: bool,
    pub max_channels: u16,
    pub supported_sample_rates: Vec<u32>,
    pub supported_bit_depths: Vec<u16>,
    pub kind: AudioSourceKind,
}

impl AudioSource {
    pub fn as_device(&self) -> AudioDevice {
        AudioDevice {
            id: self.id.clone(),
            name: self.name.clone(),
            manufacturer: self.manufacturer.clone(),
            transport: self.transport,
            is_default: self.is_default,
            max_channels: self.max_channels,
            supported_sample_rates: self.supported_sample_rates.clone(),
            supported_bit_depths: self.supported_bit_depths.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SampleFormat {
    F32,
    I16,
    I24,
    I32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfig {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub format: SampleFormat,
    /// Requests exclusive output where a backend supports it. A loopback source is always shared.
    pub exclusive: bool,
    /// Requested device-buffer size. The adapter clamps it to the endpoint's safe minimum.
    pub preferred_buffer_frames: Option<u32>,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            sample_rate_hz: 48_000,
            channels: 2,
            format: SampleFormat::F32,
            exclusive: false,
            preferred_buffer_frames: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRoute {
    pub source_device_id: String,
    pub source_kind: AudioSourceKind,
    pub output_device_id: String,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamState {
    Idle,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTelemetry {
    pub state: StreamState,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub capture_buffer_frames: u32,
    pub render_buffer_frames: u32,
    pub queue_capacity_frames: u32,
    pub queue_fill_frames: u32,
    pub clock_adjustments: u64,
    pub captured_frames: u64,
    pub rendered_frames: u64,
    pub dropped_frames: u64,
    pub underrun_frames: u64,
    pub discontinuities: u64,
    pub clipped_samples: u64,
    pub input_peak_dbfs: f32,
    pub output_peak_dbfs: f32,
}

impl Default for StreamTelemetry {
    fn default() -> Self {
        Self {
            state: StreamState::Idle,
            sample_rate_hz: 0,
            channels: 0,
            capture_buffer_frames: 0,
            render_buffer_frames: 0,
            queue_capacity_frames: 0,
            queue_fill_frames: 0,
            clock_adjustments: 0,
            captured_frames: 0,
            rendered_frames: 0,
            dropped_frames: 0,
            underrun_frames: 0,
            discontinuities: 0,
            clipped_samples: 0,
            input_peak_dbfs: -120.0,
            output_peak_dbfs: -120.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AudioError {
    BackendUnavailable(String),
    DeviceNotFound(String),
    UnsupportedConfiguration(String),
    PermissionDenied(String),
    StreamFailure(String),
    InvalidState(String),
    ProcessorFailure(String),
    Timeout(String),
}

impl fmt::Display for AudioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (label, message) = match self {
            Self::BackendUnavailable(message) => ("audio backend unavailable", message),
            Self::DeviceNotFound(message) => ("audio device not found", message),
            Self::UnsupportedConfiguration(message) => ("unsupported audio configuration", message),
            Self::PermissionDenied(message) => ("audio permission denied", message),
            Self::StreamFailure(message) => ("audio stream failed", message),
            Self::InvalidState(message) => ("invalid audio stream state", message),
            Self::ProcessorFailure(message) => ("audio processor failed", message),
            Self::Timeout(message) => ("audio operation timed out", message),
        };
        write!(formatter, "{label}: {message}")
    }
}

impl std::error::Error for AudioError {}

/// Real-time PCM insertion point. Implementations must not block, perform I/O or allocate in
/// [`AudioProcessor::process`]. The platform adapter owns the audio threads and timing policy.
pub trait AudioProcessor: Send + 'static {
    /// Called on the processing thread before audio starts.
    fn prepare(&mut self, _config: &StreamConfig) -> Result<(), AudioError> {
        Ok(())
    }

    /// Process interleaved `f32` PCM in place.
    fn process(&mut self, interleaved: &mut [f32], channels: u16);

    /// Called after the audio clients stop, including after runtime failure.
    fn stopped(&mut self) {}
}

impl<F> AudioProcessor for F
where
    F: FnMut(&mut [f32], u16) + Send + 'static,
{
    fn process(&mut self, interleaved: &mut [f32], channels: u16) {
        self(interleaved, channels);
    }
}

/// Backward-compatible name retained for the P0.2 integration surface.
pub use AudioProcessor as RenderCallback;

pub trait AudioStream: Send {
    fn route(&self) -> &AudioRoute;
    fn config(&self) -> StreamConfig;
    fn start(&mut self) -> Result<(), AudioError>;
    fn stop(&mut self) -> Result<(), AudioError>;
    fn state(&self) -> StreamState;
    fn telemetry(&self) -> StreamTelemetry;
    /// Returns and clears the last asynchronous stream failure.
    fn take_error(&mut self) -> Option<AudioError>;

    fn is_running(&self) -> bool {
        self.state() == StreamState::Running
    }
}

/// Backward-compatible name retained while native hosts migrate to [`AudioStream`].
pub use AudioStream as OutputStream;

/// Platform boundary. The DSP engine never imports WASAPI, AAudio, CoreAudio or PipeWire.
pub trait AudioBackend: Send + Sync {
    fn platform(&self) -> Platform;
    fn backend_name(&self) -> &'static str;
    fn capabilities(&self) -> PlatformCapabilities;
    fn output_devices(&self) -> Result<Vec<AudioDevice>, AudioError>;
    fn default_output_device(&self) -> Result<Option<AudioDevice>, AudioError>;
    fn audio_sources(&self) -> Result<Vec<AudioSource>, AudioError>;
    fn default_audio_source(
        &self,
        kind: AudioSourceKind,
    ) -> Result<Option<AudioSource>, AudioError>;
    fn open_processing_stream(
        &self,
        route: AudioRoute,
        config: StreamConfig,
        processor: Box<dyn AudioProcessor>,
    ) -> Result<Box<dyn AudioStream>, AudioError>;
}

pub fn validate_route(route: &AudioRoute, config: StreamConfig) -> Result<(), AudioError> {
    if route.source_device_id.trim().is_empty() {
        return Err(AudioError::DeviceNotFound(
            "source endpoint id is empty".into(),
        ));
    }
    if route.output_device_id.trim().is_empty() {
        return Err(AudioError::DeviceNotFound(
            "output endpoint id is empty".into(),
        ));
    }
    if route.source_kind == AudioSourceKind::SystemLoopback
        && route.source_device_id == route.output_device_id
    {
        return Err(AudioError::UnsupportedConfiguration(
            "a loopback source and processed output must be different endpoints to avoid a feedback loop; route Windows to a virtual endpoint and select the physical listening device as UZjam's output".into(),
        ));
    }
    if !(8_000..=384_000).contains(&config.sample_rate_hz) {
        return Err(AudioError::UnsupportedConfiguration(format!(
            "sample rate {} Hz is outside the supported 8-384 kHz range",
            config.sample_rate_hz
        )));
    }
    if config.channels == 0 || config.channels > 32 {
        return Err(AudioError::UnsupportedConfiguration(format!(
            "channel count {} is outside the supported 1-32 range",
            config.channels
        )));
    }
    if let Some(frames) = config.preferred_buffer_frames {
        if frames == 0 || frames > 1_048_576 {
            return Err(AudioError::UnsupportedConfiguration(format!(
                "preferred buffer size {frames} must be between 1 and 1048576 frames"
            )));
        }
    }
    Ok(())
}

/// Conservative product-level defaults only. Real backends must report actual runtime support.
pub fn planning_capabilities(platform: Platform) -> PlatformCapabilities {
    use SupportLevel::*;
    match platform {
        Platform::Windows => PlatformCapabilities {
            system_wide_eq: Partial,
            exclusive_mode: Partial,
            usb_direct: Partial,
            app_specific_eq: Partial,
            high_resolution_audio: Supported,
            device_switching: Supported,
            channel_routing: Supported,
        },
        Platform::Android => PlatformCapabilities {
            system_wide_eq: Partial,
            exclusive_mode: Partial,
            usb_direct: Partial,
            app_specific_eq: Partial,
            high_resolution_audio: Partial,
            device_switching: Supported,
            channel_routing: Partial,
        },
        Platform::MacOs => PlatformCapabilities {
            system_wide_eq: Partial,
            exclusive_mode: Partial,
            usb_direct: Partial,
            app_specific_eq: Partial,
            high_resolution_audio: Supported,
            device_switching: Supported,
            channel_routing: Supported,
        },
        Platform::Linux => PlatformCapabilities {
            system_wide_eq: Supported,
            exclusive_mode: Partial,
            usb_direct: Partial,
            app_specific_eq: Supported,
            high_resolution_audio: Supported,
            device_switching: Supported,
            channel_routing: Supported,
        },
        Platform::Ios => PlatformCapabilities {
            system_wide_eq: Unsupported,
            exclusive_mode: Partial,
            usb_direct: Partial,
            app_specific_eq: Unsupported,
            high_resolution_audio: Partial,
            device_switching: Partial,
            channel_routing: Partial,
        },
        Platform::Unknown => PlatformCapabilities {
            system_wide_eq: Unknown,
            exclusive_mode: Unknown,
            usb_direct: Unknown,
            app_specific_eq: Unknown,
            high_resolution_audio: Unknown,
            device_switching: Unknown,
            channel_routing: Unknown,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> AudioRoute {
        AudioRoute {
            source_device_id: "source".into(),
            source_kind: AudioSourceKind::SystemLoopback,
            output_device_id: "output".into(),
        }
    }

    #[test]
    fn android_is_not_claimed_as_fully_system_wide() {
        assert_eq!(
            planning_capabilities(Platform::Android).system_wide_eq,
            SupportLevel::Partial
        );
    }

    #[test]
    fn windows_runtime_plan_does_not_claim_driver_level_interception() {
        assert_eq!(
            planning_capabilities(Platform::Windows).system_wide_eq,
            SupportLevel::Partial
        );
    }

    #[test]
    fn loopback_route_rejects_feedback_endpoint() {
        let mut route = route();
        route.output_device_id = route.source_device_id.clone();
        let error = validate_route(&route, StreamConfig::default()).unwrap_err();
        assert!(matches!(error, AudioError::UnsupportedConfiguration(_)));
    }

    #[test]
    fn stream_config_has_product_safe_defaults() {
        let config = StreamConfig::default();
        assert_eq!(config.sample_rate_hz, 48_000);
        assert_eq!(config.channels, 2);
        assert_eq!(config.format, SampleFormat::F32);
        assert!(!config.exclusive);
        assert!(validate_route(&route(), config).is_ok());
    }
}
