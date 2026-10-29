use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::f64::consts::PI;
use uzjam_core::{ChannelMode, ClippingPolicy, EqFilter, FilterKind, HeadroomMode, UzjamProfile};

const MIN_MAGNITUDE: f64 = 1.0e-12;
const HEADROOM_SCAN_POINTS: usize = 1024;
const SMOOTHING_SEARCH_STEPS: usize = 24;
const LIMITER_LOOKAHEAD_MS: f64 = 5.0;
const LIMITER_RELEASE_MS: f64 = 80.0;
const LIMITER_OVERSAMPLE_FACTOR: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BiquadCoefficients {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DspError {
    InvalidSampleRate(f64),
    InvalidFrequency {
        frequency_hz: f64,
        sample_rate_hz: f64,
    },
    InvalidQ(f64),
    NonFiniteParameter(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrequencyResponsePoint {
    pub frequency_hz: f64,
    pub magnitude_db: f64,
}

/// Visualization response for the two physical channels and their dB-domain average.
///
/// `stereo` is `(left + right) / 2` at each frequency. It is intentionally a dB
/// average for a stable UI summary; it is not a sum of every L/R filter and it is
/// not an estimate of the peak of a mixed-down audio signal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFrequencyResponse {
    pub left: Vec<FrequencyResponsePoint>,
    pub right: Vec<FrequencyResponsePoint>,
    pub stereo: Vec<FrequencyResponsePoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadroomAnalysis {
    /// Maximum requested EQ-only transfer across the physical L/R channels.
    pub maximum_eq_gain_db: f64,
    /// Requested curve peak after user preamp, before protective attenuation.
    pub requested_curve_peak_db: f64,
    /// Effective curve peak after smoothing (if any), before headroom attenuation.
    pub effective_curve_peak_db: f64,
    /// Headroom needed by the requested curve, user preamp, and safety margin.
    pub required_headroom_db: f64,
    /// Protective attenuation selected by the active policy.
    pub applied_headroom_db: f64,
    /// User preamp minus protective attenuation.
    pub effective_preamp_db: f64,
    pub effective_preamp_linear: f64,
    /// Unused protection after the effective curve is covered. In Auto mode,
    /// the configured safety reserve appears here as positive margin.
    pub remaining_margin_db: f64,
    /// Effective curve gain not covered by applied headroom.
    pub predicted_over_db: f64,
    /// Multiplier applied only to positive filter gains in Smooth mode.
    pub smoothing_factor: f64,
    pub safety_margin_db: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveFilter {
    pub id: String,
    pub gain_db: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAnalysis {
    pub sample_rate_hz: f64,
    pub requested_response: ChannelFrequencyResponse,
    pub effective_response: ChannelFrequencyResponse,
    pub headroom: HeadroomAnalysis,
    pub effective_filters: Vec<EffectiveFilter>,
}

#[derive(Debug, Clone, Copy, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

impl BiquadState {
    fn process(&mut self, x: f64, c: BiquadCoefficients) -> f64 {
        // Transposed Direct Form II: numerically well behaved and compact.
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
}

#[derive(Debug, Clone)]
struct RuntimeFilter {
    coefficients: BiquadCoefficients,
    channel: ChannelMode,
    left: BiquadState,
    right: BiquadState,
}

#[derive(Debug, Clone)]
struct StereoLimiter {
    enabled: bool,
    ceiling_linear: f64,
    delay: Vec<[f32; 2]>,
    write_index: usize,
    sample_index: u64,
    peak_window: VecDeque<(u64, f64)>,
    detector_left: [f64; 4],
    detector_right: [f64; 4],
    gain: f64,
    release_coefficient: f64,
}

impl StereoLimiter {
    fn new(enabled: bool, safety_margin_db: f64, sample_rate_hz: f64) -> Self {
        let lookahead_frames = if enabled {
            (sample_rate_hz * LIMITER_LOOKAHEAD_MS / 1_000.0).round() as usize
        } else {
            0
        };
        let release_frames = (sample_rate_hz * LIMITER_RELEASE_MS / 1_000.0).max(1.0);
        let mut peak_window = VecDeque::with_capacity(lookahead_frames.saturating_add(2));
        peak_window.clear();
        Self {
            enabled,
            ceiling_linear: db_to_linear(-safety_margin_db.clamp(0.0, 12.0)),
            delay: vec![[0.0, 0.0]; lookahead_frames.max(1)],
            write_index: 0,
            sample_index: 0,
            peak_window,
            detector_left: [0.0; 4],
            detector_right: [0.0; 4],
            gain: 1.0,
            release_coefficient: (-1.0 / release_frames).exp(),
        }
    }

    fn latency_frames(&self) -> usize {
        if self.enabled {
            self.delay.len()
        } else {
            0
        }
    }

    fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        if !self.enabled {
            return (left, right);
        }

        self.detector_left.rotate_left(1);
        self.detector_right.rotate_left(1);
        self.detector_left[3] = finite_f64(left);
        self.detector_right[3] = finite_f64(right);
        let detected_peak = interpolated_peak(self.detector_left)
            .max(interpolated_peak(self.detector_right))
            .max((left as f64).abs())
            .max((right as f64).abs());

        while self
            .peak_window
            .back()
            .is_some_and(|(_, peak)| *peak <= detected_peak)
        {
            self.peak_window.pop_back();
        }
        self.peak_window
            .push_back((self.sample_index, detected_peak));

        let delayed = self.delay[self.write_index];
        self.delay[self.write_index] = [left, right];
        self.write_index = (self.write_index + 1) % self.delay.len();

        let output_index = self.sample_index.saturating_sub(self.delay.len() as u64);
        if self.sample_index >= self.delay.len() as u64 {
            while self
                .peak_window
                .front()
                .is_some_and(|(index, _)| *index < output_index)
            {
                self.peak_window.pop_front();
            }
        }
        self.sample_index = self.sample_index.saturating_add(1);

        let window_peak = self.peak_window.front().map_or(0.0, |(_, peak)| *peak);
        let target_gain = if window_peak > self.ceiling_linear {
            self.ceiling_linear / window_peak
        } else {
            1.0
        };
        if target_gain < self.gain {
            self.gain = target_gain;
        } else {
            self.gain = self.release_coefficient * self.gain
                + (1.0 - self.release_coefficient) * target_gain;
        }

        let ceiling = self.ceiling_linear as f32;
        (
            (delayed[0] * self.gain as f32).clamp(-ceiling, ceiling),
            (delayed[1] * self.gain as f32).clamp(-ceiling, ceiling),
        )
    }
}

fn finite_f64(sample: f32) -> f64 {
    if sample.is_finite() {
        sample as f64
    } else {
        0.0
    }
}

fn interpolated_peak(samples: [f64; 4]) -> f64 {
    let [p0, p1, p2, p3] = samples;
    let mut peak = p1.abs().max(p2.abs());
    for phase in 1..LIMITER_OVERSAMPLE_FACTOR {
        let t = phase as f64 / LIMITER_OVERSAMPLE_FACTOR as f64;
        let t2 = t * t;
        let t3 = t2 * t;
        let interpolated = 0.5
            * (2.0 * p1
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
        peak = peak.max(interpolated.abs());
    }
    peak
}

#[derive(Debug, Clone)]
pub struct StereoEqProcessor {
    filters: Vec<RuntimeFilter>,
    preamp_linear: f64,
    bypassed: bool,
    limiter: StereoLimiter,
}

impl StereoEqProcessor {
    pub fn from_profile(profile: &UzjamProfile, sample_rate_hz: f64) -> Result<Self, DspError> {
        validate_sample_rate(sample_rate_hz)?;
        let headroom = analyze_headroom(profile, sample_rate_hz, HEADROOM_SCAN_POINTS)?;
        let effective_filters = runtime_effective_filters(profile, headroom.smoothing_factor);
        let mut filters = Vec::new();

        if profile.dsp.enabled {
            for filter in effective_filters.iter().filter(|filter| filter.enabled) {
                filters.push(RuntimeFilter {
                    coefficients: coefficients(filter, sample_rate_hz)?,
                    channel: filter.channel,
                    left: BiquadState::default(),
                    right: BiquadState::default(),
                });
            }
        }

        Ok(Self {
            filters,
            preamp_linear: headroom.effective_preamp_linear,
            bypassed: !profile.dsp.enabled,
            limiter: StereoLimiter::new(
                profile.dsp.enabled && profile.dsp.limiter_enabled,
                profile.dsp.safety_margin_db,
                sample_rate_hz,
            ),
        })
    }

    pub fn latency_frames(&self) -> usize {
        self.limiter.latency_frames()
    }

    pub fn process_stereo_frame(&mut self, left: f32, right: f32) -> (f32, f32) {
        let (left, right) = if self.bypassed {
            (left, right)
        } else {
            let mut left = left as f64 * self.preamp_linear;
            let mut right = right as f64 * self.preamp_linear;
            for filter in &mut self.filters {
                if filter.channel.applies_to_left() {
                    left = filter.left.process(left, filter.coefficients);
                }
                if filter.channel.applies_to_right() {
                    right = filter.right.process(right, filter.coefficients);
                }
            }
            (left as f32, right as f32)
        };
        self.limiter.process(left, right)
    }

    pub fn process_interleaved_stereo(&mut self, samples: &mut [f32]) {
        let (frames, _remainder) = samples.as_chunks_mut::<2>();
        for frame in frames {
            let (left, right) = self.process_stereo_frame(frame[0], frame[1]);
            frame[0] = left;
            frame[1] = right;
        }
    }
}

pub fn coefficients(
    filter: &EqFilter,
    sample_rate_hz: f64,
) -> Result<BiquadCoefficients, DspError> {
    validate_sample_rate(sample_rate_hz)?;
    if !filter.frequency_hz.is_finite() {
        return Err(DspError::NonFiniteParameter("frequency_hz"));
    }
    if filter.frequency_hz <= 0.0 || filter.frequency_hz >= sample_rate_hz * 0.5 {
        return Err(DspError::InvalidFrequency {
            frequency_hz: filter.frequency_hz,
            sample_rate_hz,
        });
    }

    let uses_q = !matches!(filter.kind, FilterKind::LowShelf | FilterKind::HighShelf);
    if uses_q && !filter.q.is_finite() {
        return Err(DspError::NonFiniteParameter("q"));
    }
    if uses_q && filter.q <= 0.0 {
        return Err(DspError::InvalidQ(filter.q));
    }
    if !filter.gain_db.is_finite() {
        return Err(DspError::NonFiniteParameter("gain_db"));
    }

    let w0 = 2.0 * PI * filter.frequency_hz / sample_rate_hz;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let alpha = if uses_q {
        sin_w0 / (2.0 * filter.q)
    } else {
        0.0
    };
    let a = 10.0_f64.powf(filter.gain_db / 40.0);
    let sqrt_a = a.sqrt();

    let (b0, b1, b2, a0, a1, a2) = match filter.kind {
        FilterKind::Peak => (
            1.0 + alpha * a,
            -2.0 * cos_w0,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos_w0,
            1.0 - alpha / a,
        ),
        FilterKind::LowShelf => {
            // RBJ shelf slope S=1. Q is deliberately not used for shelf filters.
            let shelf_alpha = sin_w0 / 2.0 * 2.0_f64.sqrt();
            let beta = 2.0 * sqrt_a * shelf_alpha;
            (
                a * ((a + 1.0) - (a - 1.0) * cos_w0 + beta),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                a * ((a + 1.0) - (a - 1.0) * cos_w0 - beta),
                (a + 1.0) + (a - 1.0) * cos_w0 + beta,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                (a + 1.0) + (a - 1.0) * cos_w0 - beta,
            )
        }
        FilterKind::HighShelf => {
            // RBJ shelf slope S=1. Q is deliberately not used for shelf filters.
            let shelf_alpha = sin_w0 / 2.0 * 2.0_f64.sqrt();
            let beta = 2.0 * sqrt_a * shelf_alpha;
            (
                a * ((a + 1.0) + (a - 1.0) * cos_w0 + beta),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                a * ((a + 1.0) + (a - 1.0) * cos_w0 - beta),
                (a + 1.0) - (a - 1.0) * cos_w0 + beta,
                2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                (a + 1.0) - (a - 1.0) * cos_w0 - beta,
            )
        }
        FilterKind::LowPass => (
            (1.0 - cos_w0) / 2.0,
            1.0 - cos_w0,
            (1.0 - cos_w0) / 2.0,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        FilterKind::HighPass => (
            (1.0 + cos_w0) / 2.0,
            -(1.0 + cos_w0),
            (1.0 + cos_w0) / 2.0,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        FilterKind::Notch => (
            1.0,
            -2.0 * cos_w0,
            1.0,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
        FilterKind::BandPass => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha),
        FilterKind::AllPass => (
            1.0 - alpha,
            -2.0 * cos_w0,
            1.0 + alpha,
            1.0 + alpha,
            -2.0 * cos_w0,
            1.0 - alpha,
        ),
    };

    Ok(normalize(b0, b1, b2, a0, a1, a2))
}

pub fn filter_magnitude_db(
    filter: &EqFilter,
    sample_rate_hz: f64,
    frequency_hz: f64,
) -> Result<f64, DspError> {
    let coefficients = coefficients(filter, sample_rate_hz)?;
    if !frequency_hz.is_finite() || frequency_hz < 0.0 || frequency_hz > sample_rate_hz * 0.5 {
        return Err(DspError::InvalidFrequency {
            frequency_hz,
            sample_rate_hz,
        });
    }
    let w = 2.0 * PI * frequency_hz / sample_rate_hz;
    let z1_re = w.cos();
    let z1_im = -w.sin();
    let z2_re = (2.0 * w).cos();
    let z2_im = -(2.0 * w).sin();

    let numerator_re = coefficients.b0 + coefficients.b1 * z1_re + coefficients.b2 * z2_re;
    let numerator_im = coefficients.b1 * z1_im + coefficients.b2 * z2_im;
    let denominator_re = 1.0 + coefficients.a1 * z1_re + coefficients.a2 * z2_re;
    let denominator_im = coefficients.a1 * z1_im + coefficients.a2 * z2_im;

    let numerator = (numerator_re * numerator_re + numerator_im * numerator_im).sqrt();
    let denominator = (denominator_re * denominator_re + denominator_im * denominator_im)
        .sqrt()
        .max(MIN_MAGNITUDE);
    Ok(20.0 * (numerator.max(MIN_MAGNITUDE) / denominator).log10())
}

/// Requested EQ-only response for a physical channel or the stereo visualization.
/// Stereo is the dB average of the independent left and right responses.
pub fn requested_channel_response_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    frequency_hz: f64,
    channel: ChannelMode,
) -> Result<f64, DspError> {
    channel_response_db(profile, sample_rate_hz, frequency_hz, channel, 1.0)
}

/// Effective EQ-only response using the positive-gain factor derived by the engine.
/// Stereo is the dB average of the independent left and right responses.
pub fn effective_channel_response_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    frequency_hz: f64,
    channel: ChannelMode,
    smoothing_factor: f64,
) -> Result<f64, DspError> {
    if !smoothing_factor.is_finite() {
        return Err(DspError::NonFiniteParameter("smoothing_factor"));
    }
    channel_response_db(
        profile,
        sample_rate_hz,
        frequency_hz,
        channel,
        smoothing_factor.clamp(0.0, 1.0),
    )
}

/// Backward-compatible effective response helper. When `include_preamp` is true,
/// the engine-derived effective preamp (user preamp minus headroom) is included.
pub fn profile_response_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    frequency_hz: f64,
    channel: ChannelMode,
    include_preamp: bool,
) -> Result<f64, DspError> {
    let headroom = analyze_headroom(profile, sample_rate_hz, HEADROOM_SCAN_POINTS)?;
    let mut response = effective_channel_response_db(
        profile,
        sample_rate_hz,
        frequency_hz,
        channel,
        headroom.smoothing_factor,
    )?;
    if include_preamp && profile.dsp.enabled {
        response += headroom.effective_preamp_db;
    }
    Ok(response)
}

/// Maximum requested EQ-only transfer over the left and right physical channels.
pub fn max_filter_gain_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
) -> Result<f64, DspError> {
    max_eq_gain_with_factor(profile, sample_rate_hz, points, 1.0)
}

/// Analyze protection and effective gain without allocating response curves.
pub fn analyze_headroom(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
) -> Result<HeadroomAnalysis, DspError> {
    validate_sample_rate(sample_rate_hz)?;
    if !profile.dsp.enabled {
        return Ok(bypassed_headroom(profile.dsp.safety_margin_db));
    }

    let maximum_eq_gain_db = max_eq_gain_with_factor(profile, sample_rate_hz, points, 1.0)?;
    let requested_curve_peak_db = (maximum_eq_gain_db + profile.dsp.preamp_db).max(0.0);
    let required_headroom_db = requested_curve_peak_db + profile.dsp.safety_margin_db;

    let protection_off = profile.dsp.headroom_mode == HeadroomMode::Off
        || profile.dsp.clipping_policy == ClippingPolicy::AllowClipping;
    let smooth = !protection_off && profile.dsp.clipping_policy == ClippingPolicy::Smooth;

    let (applied_headroom_db, smoothing_factor) = if protection_off {
        (0.0, 1.0)
    } else if smooth {
        let applied = profile.dsp.manual_headroom_db.max(0.0);
        let factor = derive_smoothing_factor(profile, sample_rate_hz, points, applied)?;
        (applied, factor)
    } else if profile.dsp.headroom_mode == HeadroomMode::Manual
        || profile.dsp.clipping_policy == ClippingPolicy::Curve
    {
        (profile.dsp.manual_headroom_db.max(0.0), 1.0)
    } else {
        (required_headroom_db, 1.0)
    };

    let effective_maximum_eq_gain_db =
        max_eq_gain_with_factor(profile, sample_rate_hz, points, smoothing_factor)?;
    let effective_curve_peak_db = (effective_maximum_eq_gain_db + profile.dsp.preamp_db).max(0.0);
    let remaining_margin_db = applied_headroom_db - effective_curve_peak_db;
    let predicted_over_db = (-remaining_margin_db).max(0.0);
    let effective_preamp_db = profile.dsp.preamp_db - applied_headroom_db;

    Ok(HeadroomAnalysis {
        maximum_eq_gain_db,
        requested_curve_peak_db,
        effective_curve_peak_db,
        required_headroom_db,
        applied_headroom_db,
        effective_preamp_db,
        effective_preamp_linear: db_to_linear(effective_preamp_db),
        remaining_margin_db,
        predicted_over_db,
        smoothing_factor,
        safety_margin_db: profile.dsp.safety_margin_db,
    })
}

/// Produce the complete engine-owned data consumed by the UI and the processor.
pub fn analyze_profile(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    response_points: usize,
) -> Result<EngineAnalysis, DspError> {
    validate_sample_rate(sample_rate_hz)?;
    let headroom = analyze_headroom(
        profile,
        sample_rate_hz,
        response_points.max(HEADROOM_SCAN_POINTS),
    )?;
    let frequencies = frequency_grid(sample_rate_hz, response_points.max(2));
    let requested_response =
        channel_frequency_response(profile, sample_rate_hz, &frequencies, 1.0)?;
    let effective_response = channel_frequency_response(
        profile,
        sample_rate_hz,
        &frequencies,
        headroom.smoothing_factor,
    )?;

    Ok(EngineAnalysis {
        sample_rate_hz,
        requested_response,
        effective_response,
        headroom,
        effective_filters: reported_effective_filters(profile, headroom.smoothing_factor),
    })
}

/// Effective preamp for automatic protection while retaining the independent user preamp.
pub fn recommended_auto_preamp_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
) -> Result<f64, DspError> {
    if !profile.dsp.enabled {
        return Ok(0.0);
    }
    let maximum_eq_gain_db = max_filter_gain_db(profile, sample_rate_hz, points)?;
    let requested_curve_peak_db = (maximum_eq_gain_db + profile.dsp.preamp_db).max(0.0);
    let required_headroom_db = requested_curve_peak_db + profile.dsp.safety_margin_db;
    Ok(profile.dsp.preamp_db - required_headroom_db)
}

pub fn effective_preamp_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
) -> Result<f64, DspError> {
    Ok(analyze_headroom(profile, sample_rate_hz, points)?.effective_preamp_db)
}

pub fn estimate_output_peak_dbfs(
    input_peak_dbfs: f64,
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
) -> Result<f64, DspError> {
    if !input_peak_dbfs.is_finite() {
        return Err(DspError::NonFiniteParameter("input_peak_dbfs"));
    }
    if !profile.dsp.enabled {
        return Ok(input_peak_dbfs);
    }

    let headroom = analyze_headroom(profile, sample_rate_hz, points)?;
    let transfer =
        max_eq_gain_with_factor(profile, sample_rate_hz, points, headroom.smoothing_factor)?;
    Ok(input_peak_dbfs + transfer + headroom.effective_preamp_db)
}

fn channel_frequency_response(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    frequencies: &[f64],
    smoothing_factor: f64,
) -> Result<ChannelFrequencyResponse, DspError> {
    let mut left = Vec::with_capacity(frequencies.len());
    let mut right = Vec::with_capacity(frequencies.len());
    let mut stereo = Vec::with_capacity(frequencies.len());

    for &frequency_hz in frequencies {
        let left_db = channel_response_db(
            profile,
            sample_rate_hz,
            frequency_hz,
            ChannelMode::Left,
            smoothing_factor,
        )?;
        let right_db = channel_response_db(
            profile,
            sample_rate_hz,
            frequency_hz,
            ChannelMode::Right,
            smoothing_factor,
        )?;
        left.push(FrequencyResponsePoint {
            frequency_hz,
            magnitude_db: left_db,
        });
        right.push(FrequencyResponsePoint {
            frequency_hz,
            magnitude_db: right_db,
        });
        stereo.push(FrequencyResponsePoint {
            frequency_hz,
            magnitude_db: (left_db + right_db) / 2.0,
        });
    }

    Ok(ChannelFrequencyResponse {
        left,
        right,
        stereo,
    })
}

fn channel_response_db(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    frequency_hz: f64,
    channel: ChannelMode,
    smoothing_factor: f64,
) -> Result<f64, DspError> {
    validate_sample_rate(sample_rate_hz)?;
    if !profile.dsp.enabled {
        return Ok(0.0);
    }

    if channel == ChannelMode::Stereo {
        let left = channel_response_db(
            profile,
            sample_rate_hz,
            frequency_hz,
            ChannelMode::Left,
            smoothing_factor,
        )?;
        let right = channel_response_db(
            profile,
            sample_rate_hz,
            frequency_hz,
            ChannelMode::Right,
            smoothing_factor,
        )?;
        return Ok((left + right) / 2.0);
    }

    let mut response_db = 0.0;
    for filter in profile.filters.iter().filter(|filter| filter.enabled) {
        let applies = match channel {
            ChannelMode::Left => filter.channel.applies_to_left(),
            ChannelMode::Right => filter.channel.applies_to_right(),
            ChannelMode::Stereo => unreachable!("stereo is handled before filter iteration"),
        };
        if applies {
            let mut effective = filter.clone();
            if effective.gain_db > 0.0 {
                effective.gain_db *= smoothing_factor;
            }
            response_db += filter_magnitude_db(&effective, sample_rate_hz, frequency_hz)?;
        }
    }
    Ok(response_db)
}

fn max_eq_gain_with_factor(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
    smoothing_factor: f64,
) -> Result<f64, DspError> {
    validate_sample_rate(sample_rate_hz)?;
    if !profile.dsp.enabled {
        return Ok(0.0);
    }

    let mut maximum_gain_db: f64 = 0.0;
    for frequency_hz in headroom_frequency_grid(profile, sample_rate_hz, points.max(64)) {
        for channel in [ChannelMode::Left, ChannelMode::Right] {
            maximum_gain_db = maximum_gain_db.max(channel_response_db(
                profile,
                sample_rate_hz,
                frequency_hz,
                channel,
                smoothing_factor,
            )?);
        }
    }
    Ok(maximum_gain_db)
}

fn derive_smoothing_factor(
    profile: &UzjamProfile,
    sample_rate_hz: f64,
    points: usize,
    applied_headroom_db: f64,
) -> Result<f64, DspError> {
    let target_curve_peak_db = (applied_headroom_db - profile.dsp.safety_margin_db).max(0.0);
    let effective_curve_peak = |factor| -> Result<f64, DspError> {
        let maximum_eq_gain_db = max_eq_gain_with_factor(profile, sample_rate_hz, points, factor)?;
        Ok((maximum_eq_gain_db + profile.dsp.preamp_db).max(0.0))
    };

    if effective_curve_peak(1.0)? <= target_curve_peak_db {
        return Ok(1.0);
    }
    if effective_curve_peak(0.0)? > target_curve_peak_db {
        return Ok(0.0);
    }

    let mut fitting = 0.0;
    let mut excessive = 1.0;
    for _ in 0..SMOOTHING_SEARCH_STEPS {
        let candidate = (fitting + excessive) / 2.0;
        if effective_curve_peak(candidate)? <= target_curve_peak_db {
            fitting = candidate;
        } else {
            excessive = candidate;
        }
    }
    Ok(fitting)
}

fn runtime_effective_filters(profile: &UzjamProfile, smoothing_factor: f64) -> Vec<EqFilter> {
    profile
        .filters
        .iter()
        .cloned()
        .map(|mut filter| {
            if filter.enabled && filter.gain_db > 0.0 {
                filter.gain_db *= smoothing_factor;
            }
            filter
        })
        .collect()
}

fn reported_effective_filters(
    profile: &UzjamProfile,
    smoothing_factor: f64,
) -> Vec<EffectiveFilter> {
    profile
        .filters
        .iter()
        .map(|filter| EffectiveFilter {
            id: filter.id.clone(),
            gain_db: if profile.dsp.enabled && filter.enabled {
                if filter.gain_db > 0.0 {
                    filter.gain_db * smoothing_factor
                } else {
                    filter.gain_db
                }
            } else {
                0.0
            },
        })
        .collect()
}

fn headroom_frequency_grid(profile: &UzjamProfile, sample_rate_hz: f64, points: usize) -> Vec<f64> {
    let mut frequencies = frequency_grid(sample_rate_hz, points);
    let minimum_frequency = frequencies[0];
    let maximum_frequency = frequencies[frequencies.len() - 1];
    frequencies.extend(
        profile
            .filters
            .iter()
            .filter(|filter| filter.enabled)
            .map(|filter| filter.frequency_hz)
            .filter(|frequency_hz| {
                *frequency_hz >= minimum_frequency && *frequency_hz <= maximum_frequency
            }),
    );
    frequencies.sort_by(f64::total_cmp);
    frequencies.dedup();
    frequencies
}

fn frequency_grid(sample_rate_hz: f64, points: usize) -> Vec<f64> {
    let maximum_frequency = (sample_rate_hz * 0.5 * 0.999).min(20_000.0);
    let minimum_frequency = 20.0_f64.min(maximum_frequency * 0.5);
    let count = points.max(2);

    (0..count)
        .map(|index| {
            let ratio = index as f64 / (count - 1) as f64;
            minimum_frequency * (maximum_frequency / minimum_frequency).powf(ratio)
        })
        .collect()
}

fn bypassed_headroom(safety_margin_db: f64) -> HeadroomAnalysis {
    HeadroomAnalysis {
        maximum_eq_gain_db: 0.0,
        requested_curve_peak_db: 0.0,
        effective_curve_peak_db: 0.0,
        required_headroom_db: 0.0,
        applied_headroom_db: 0.0,
        effective_preamp_db: 0.0,
        effective_preamp_linear: 1.0,
        remaining_margin_db: 0.0,
        predicted_over_db: 0.0,
        smoothing_factor: 1.0,
        safety_margin_db,
    }
}

fn validate_sample_rate(sample_rate_hz: f64) -> Result<(), DspError> {
    if !sample_rate_hz.is_finite() || sample_rate_hz <= 40.0 {
        Err(DspError::InvalidSampleRate(sample_rate_hz))
    } else {
        Ok(())
    }
}

fn normalize(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> BiquadCoefficients {
    BiquadCoefficients {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn db_to_linear(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uzjam_core::{DspSettings, ProfileMetadata, PROFILE_SCHEMA_VERSION};

    fn filter(kind: FilterKind, frequency_hz: f64, gain_db: f64, q: f64) -> EqFilter {
        EqFilter {
            id: "f1".into(),
            enabled: true,
            kind,
            frequency_hz,
            gain_db,
            q,
            channel: ChannelMode::Stereo,
        }
    }

    fn profile(filters: Vec<EqFilter>) -> UzjamProfile {
        UzjamProfile {
            schema_version: PROFILE_SCHEMA_VERSION,
            id: "p".into(),
            name: "P".into(),
            filters,
            dsp: DspSettings {
                enabled: true,
                preamp_db: 0.0,
                manual_headroom_db: 0.0,
                headroom_mode: HeadroomMode::Auto,
                safety_margin_db: 0.3,
                clipping_policy: ClippingPolicy::Auto,
                limiter_enabled: false,
            },
            target: None,
            device_binding: None,
            metadata: ProfileMetadata {
                created_at_utc: "2026-10-04T00:00:00Z".into(),
                modified_at_utc: "2026-10-04T00:00:00Z".into(),
                source: None,
            },
        }
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected} +/- {tolerance}, got {actual}"
        );
    }

    #[test]
    fn peaking_filter_hits_requested_gain_at_center() {
        let filter = filter(FilterKind::Peak, 1000.0, 6.0, 1.0);
        let db = filter_magnitude_db(&filter, 48_000.0, 1000.0).unwrap();
        assert_close(db, 6.0, 1.0e-9);
    }

    #[test]
    fn shelves_use_rbj_slope_one_and_ignore_q() {
        let low_q = filter(FilterKind::LowShelf, 1000.0, 6.0, 0.1);
        let high_q = EqFilter {
            q: 20.0,
            ..low_q.clone()
        };
        assert_eq!(
            coefficients(&low_q, 48_000.0).unwrap(),
            coefficients(&high_q, 48_000.0).unwrap()
        );

        let invalid_q = EqFilter {
            q: f64::NAN,
            ..low_q
        };
        assert!(coefficients(&invalid_q, 48_000.0).is_ok());
    }

    #[test]
    fn stereo_visualization_is_db_average_of_left_and_right() {
        let mut left_filter = filter(FilterKind::Peak, 1000.0, 6.0, 1.0);
        left_filter.channel = ChannelMode::Left;
        let profile = profile(vec![left_filter]);

        let left =
            requested_channel_response_db(&profile, 48_000.0, 1000.0, ChannelMode::Left).unwrap();
        let right =
            requested_channel_response_db(&profile, 48_000.0, 1000.0, ChannelMode::Right).unwrap();
        let stereo =
            requested_channel_response_db(&profile, 48_000.0, 1000.0, ChannelMode::Stereo).unwrap();

        assert_close(left, 6.0, 1.0e-9);
        assert_close(right, 0.0, 1.0e-9);
        assert_close(stereo, 3.0, 1.0e-9);
    }

    #[test]
    fn auto_uses_cascade_user_preamp_and_safety_margin() {
        let mut profile = profile(vec![
            filter(FilterKind::Peak, 1000.0, 6.0, 1.0),
            EqFilter {
                id: "f2".into(),
                ..filter(FilterKind::Peak, 1000.0, 3.0, 1.0)
            },
        ]);
        profile.dsp.preamp_db = 2.0;

        let analysis = analyze_headroom(&profile, 48_000.0, 4096).unwrap();
        assert_close(analysis.maximum_eq_gain_db, 9.0, 0.001);
        assert_close(analysis.requested_curve_peak_db, 11.0, 0.001);
        assert_close(analysis.required_headroom_db, 11.3, 0.001);
        assert_close(analysis.applied_headroom_db, 11.3, 0.001);
        // User preamp remains +2 dB; protection independently contributes -11.3 dB.
        assert_close(analysis.effective_preamp_db, -9.3, 0.001);
        assert_close(analysis.remaining_margin_db, 0.3, 0.001);
        assert_eq!(analysis.predicted_over_db, 0.0);
    }

    #[test]
    fn manual_headroom_does_not_overwrite_user_preamp() {
        let mut profile = profile(vec![filter(FilterKind::Peak, 1000.0, 6.0, 1.0)]);
        profile.dsp.preamp_db = 3.0;
        profile.dsp.manual_headroom_db = 4.0;
        profile.dsp.headroom_mode = HeadroomMode::Manual;

        let analysis = analyze_headroom(&profile, 48_000.0, 4096).unwrap();
        assert_close(analysis.applied_headroom_db, 4.0, 1.0e-9);
        assert_close(analysis.effective_preamp_db, -1.0, 1.0e-9);
        assert_close(analysis.predicted_over_db, 5.0, 0.001);
    }

    #[test]
    fn smooth_scales_only_positive_gains_to_fit_manual_budget() {
        let mut boost = filter(FilterKind::Peak, 1000.0, 9.0, 1.0);
        boost.id = "boost".into();
        let mut cut = filter(FilterKind::Peak, 4000.0, -3.0, 1.2);
        cut.id = "cut".into();
        let mut profile = profile(vec![boost, cut]);
        profile.dsp.manual_headroom_db = 4.0;
        profile.dsp.headroom_mode = HeadroomMode::Manual;
        profile.dsp.clipping_policy = ClippingPolicy::Smooth;

        let analysis = analyze_profile(&profile, 48_000.0, 512).unwrap();
        assert!(analysis.headroom.smoothing_factor > 0.0);
        assert!(analysis.headroom.smoothing_factor < 1.0);
        assert!(analysis.headroom.predicted_over_db < 0.002);
        assert!(analysis.headroom.remaining_margin_db >= 0.299);
        assert_close(analysis.effective_filters[1].gain_db, -3.0, 1.0e-12);
        assert_close(
            analysis.effective_filters[0].gain_db,
            9.0 * analysis.headroom.smoothing_factor,
            1.0e-12,
        );
    }

    #[test]
    fn off_or_allow_clipping_applies_no_protection() {
        let mut profile = profile(vec![filter(FilterKind::Peak, 1000.0, 6.0, 1.0)]);
        profile.dsp.manual_headroom_db = 12.0;
        profile.dsp.headroom_mode = HeadroomMode::Off;
        let off = analyze_headroom(&profile, 48_000.0, 1024).unwrap();
        assert_eq!(off.applied_headroom_db, 0.0);
        assert_eq!(off.smoothing_factor, 1.0);

        profile.dsp.headroom_mode = HeadroomMode::Auto;
        profile.dsp.clipping_policy = ClippingPolicy::AllowClipping;
        let allow = analyze_headroom(&profile, 48_000.0, 1024).unwrap();
        assert_eq!(allow.applied_headroom_db, 0.0);
        assert_eq!(allow.smoothing_factor, 1.0);
    }

    #[test]
    fn bypass_is_flat_and_applies_no_protection() {
        let mut profile = profile(vec![filter(FilterKind::Peak, 1000.0, 12.0, 1.0)]);
        profile.dsp.enabled = false;
        profile.dsp.preamp_db = 8.0;

        let analysis = analyze_profile(&profile, 48_000.0, 32).unwrap();
        assert_eq!(analysis.effective_filters.len(), 1);
        assert_eq!(analysis.effective_filters[0].gain_db, 0.0);
        assert_eq!(
            analysis.headroom,
            bypassed_headroom(profile.dsp.safety_margin_db)
        );
        assert!(analysis
            .requested_response
            .stereo
            .iter()
            .all(|point| point.magnitude_db == 0.0));
        assert!(analysis
            .effective_response
            .stereo
            .iter()
            .all(|point| point.magnitude_db == 0.0));
    }

    #[test]
    fn processor_uses_effective_preamp_and_smoothed_coefficients() {
        let mut profile = profile(vec![filter(FilterKind::Peak, 1000.0, 9.0, 1.0)]);
        profile.dsp.preamp_db = 1.0;
        profile.dsp.manual_headroom_db = 4.0;
        profile.dsp.headroom_mode = HeadroomMode::Manual;
        profile.dsp.clipping_policy = ClippingPolicy::Smooth;

        let analysis = analyze_headroom(&profile, 48_000.0, HEADROOM_SCAN_POINTS).unwrap();
        let processor = StereoEqProcessor::from_profile(&profile, 48_000.0).unwrap();
        assert_close(
            processor.preamp_linear,
            analysis.effective_preamp_linear,
            1.0e-12,
        );

        let mut effective_filter = profile.filters[0].clone();
        effective_filter.gain_db *= analysis.smoothing_factor;
        assert_eq!(
            processor.filters[0].coefficients,
            coefficients(&effective_filter, 48_000.0).unwrap()
        );
    }

    #[test]
    fn processor_respects_channel_specific_filter() {
        let mut filter = filter(FilterKind::Peak, 1000.0, 6.0, 1.0);
        filter.channel = ChannelMode::Left;
        let mut profile = profile(vec![filter]);
        profile.dsp.headroom_mode = HeadroomMode::Off;
        let mut processor = StereoEqProcessor::from_profile(&profile, 48_000.0).unwrap();

        for _ in 0..256 {
            let (_left, right) = processor.process_stereo_frame(0.25, 0.25);
            assert!((right - 0.25).abs() < 1.0e-7);
        }
    }

    #[test]
    fn odd_interleaved_tail_is_left_untouched() {
        let profile = profile(Vec::new());
        let mut processor = StereoEqProcessor::from_profile(&profile, 48_000.0).unwrap();
        let mut samples = [0.25, -0.25, 0.75];
        processor.process_interleaved_stereo(&mut samples);
        assert_eq!(samples[2], 0.75);
    }

    #[test]
    fn lookahead_limiter_holds_output_below_its_ceiling() {
        let mut profile = profile(Vec::new());
        profile.dsp.headroom_mode = HeadroomMode::Off;
        profile.dsp.clipping_policy = ClippingPolicy::AllowClipping;
        profile.dsp.preamp_db = 12.0;
        profile.dsp.safety_margin_db = 1.0;
        profile.dsp.limiter_enabled = true;
        let mut processor = StereoEqProcessor::from_profile(&profile, 48_000.0).unwrap();
        assert_eq!(processor.latency_frames(), 240);

        let ceiling = db_to_linear(-1.0) as f32;
        let mut maximum = 0.0_f32;
        for _ in 0..2_000 {
            let (left, right) = processor.process_stereo_frame(0.9, -0.9);
            maximum = maximum.max(left.abs()).max(right.abs());
        }
        assert!(maximum <= ceiling + 1.0e-6, "{maximum} exceeded {ceiling}");
        assert!(maximum > ceiling * 0.95);
    }

    #[test]
    fn limiter_is_stereo_linked_and_disabled_path_has_zero_latency() {
        let mut limited_profile = profile(Vec::new());
        limited_profile.dsp.headroom_mode = HeadroomMode::Off;
        limited_profile.dsp.clipping_policy = ClippingPolicy::AllowClipping;
        limited_profile.dsp.limiter_enabled = true;
        let mut limited = StereoEqProcessor::from_profile(&limited_profile, 1_000.0).unwrap();
        let mut output = (0.0, 0.0);
        for _ in 0..200 {
            output = limited.process_stereo_frame(2.0, 0.5);
        }
        assert!(output.0 <= db_to_linear(-0.3) as f32 + 1.0e-6);
        assert!(output.1 > 0.0 && output.1 < 0.3);

        let mut bypass_profile = profile(Vec::new());
        bypass_profile.dsp.headroom_mode = HeadroomMode::Off;
        let mut unlimited = StereoEqProcessor::from_profile(&bypass_profile, 48_000.0).unwrap();
        assert_eq!(unlimited.latency_frames(), 0);
        assert_eq!(unlimited.process_stereo_frame(0.25, -0.5), (0.25, -0.5));
    }
}
