use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, TryLockError};
use uzjam_audio::{
    AudioBackend, AudioDevice, AudioError, AudioProcessor, AudioRoute, AudioSource,
    AudioSourceKind, AudioStream, PlatformCapabilities, SampleFormat, StreamConfig, StreamState,
    StreamTelemetry,
};
use uzjam_core::{UzjamProfile, ValidationSeverity};
use uzjam_dsp::StereoEqProcessor;

#[cfg(windows)]
use uzjam_audio::{ExternalPcmInput, WasapiBackend};

const DEFAULT_SAMPLE_RATE_HZ: u32 = 48_000;
const DEFAULT_BUFFER_FRAMES: u32 = 256;
const PROFILE_CROSSFADE_MS: u32 = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioInventory {
    pub backend: String,
    pub input_devices: Vec<AudioSource>,
    pub output_devices: Vec<AudioDevice>,
    pub default_input_id: Option<String>,
    pub default_output_id: Option<String>,
    pub recommended_input_id: Option<String>,
    pub capabilities: PlatformCapabilities,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStartRequest {
    pub source_device_id: String,
    pub output_device_id: String,
    pub preferred_buffer_frames: Option<u32>,
    pub profile: UzjamProfile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionAudioStartRequest {
    pub output_device_id: String,
    pub preferred_buffer_frames: Option<u32>,
    pub profile: UzjamProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStatus {
    pub available: bool,
    pub running: bool,
    pub state: StreamState,
    pub backend: String,
    pub status_detail: String,
    pub source_device_id: Option<String>,
    pub output_device_id: Option<String>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub sample_format: &'static str,
    pub buffer_frames: u32,
    pub estimated_latency_ms: f64,
    pub queue_fill_frames: u32,
    pub queue_capacity_frames: u32,
    pub clock_adjustments: u64,
    pub xruns: u64,
    pub dropped_frames: u64,
    pub underrun_frames: u64,
    pub discontinuities: u64,
    pub clipped_samples: u64,
    pub input_peak_dbfs: f32,
    pub output_peak_dbfs: f32,
    pub last_error: Option<String>,
}

impl NativeAudioStatus {
    fn idle(available: bool, backend: &str, last_error: Option<String>) -> Self {
        Self {
            available,
            running: false,
            state: StreamState::Idle,
            backend: backend.into(),
            status_detail: if available {
                "Choose a source and listening output.".into()
            } else {
                "Native audio is available on Windows.".into()
            },
            source_device_id: None,
            output_device_id: None,
            sample_rate_hz: 0,
            channels: 0,
            sample_format: "f32",
            buffer_frames: 0,
            estimated_latency_ms: 0.0,
            queue_fill_frames: 0,
            queue_capacity_frames: 0,
            clock_adjustments: 0,
            xruns: 0,
            dropped_frames: 0,
            underrun_frames: 0,
            discontinuities: 0,
            clipped_samples: 0,
            input_peak_dbfs: -120.0,
            output_peak_dbfs: -120.0,
            last_error,
        }
    }
}

enum ProcessorPhase {
    Stable(StereoEqProcessor),
    Crossfading {
        from: StereoEqProcessor,
        to: StereoEqProcessor,
        completed_frames: u32,
        total_frames: u32,
    },
    LatencyTransition {
        from: StereoEqProcessor,
        to: StereoEqProcessor,
        completed_frames: u32,
        total_frames: u32,
    },
}

struct LiveEqProcessor {
    phase: Option<ProcessorPhase>,
    pending: Arc<Mutex<Option<StereoEqProcessor>>>,
    crossfade_frames: u32,
}

impl LiveEqProcessor {
    fn new(
        initial: StereoEqProcessor,
        pending: Arc<Mutex<Option<StereoEqProcessor>>>,
        sample_rate_hz: u32,
    ) -> Self {
        Self {
            phase: Some(ProcessorPhase::Stable(initial)),
            pending,
            crossfade_frames: (sample_rate_hz.saturating_mul(PROFILE_CROSSFADE_MS) / 1_000).max(1),
        }
    }

    fn take_pending(&self) -> Option<StereoEqProcessor> {
        match self.pending.try_lock() {
            Ok(mut slot) => slot.take(),
            Err(TryLockError::Poisoned(error)) => error.into_inner().take(),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    fn install(&mut self, next: StereoEqProcessor) {
        let current = self
            .phase
            .take()
            .expect("processor phase is always present");
        let from = match current {
            ProcessorPhase::Stable(processor) => processor,
            ProcessorPhase::Crossfading { to, .. } => to,
            ProcessorPhase::LatencyTransition { to, .. } => to,
        };
        self.phase = if from.latency_frames() == next.latency_frames() {
            Some(ProcessorPhase::Crossfading {
                from,
                to: next,
                completed_frames: 0,
                total_frames: self.crossfade_frames,
            })
        } else {
            Some(ProcessorPhase::LatencyTransition {
                from,
                to: next,
                completed_frames: 0,
                total_frames: self.crossfade_frames,
            })
        };
    }

    fn finish_crossfade_if_ready(&mut self) {
        let finished = matches!(
            self.phase,
            Some(ProcessorPhase::Crossfading {
                completed_frames,
                total_frames,
                ..
            } | ProcessorPhase::LatencyTransition {
                completed_frames,
                total_frames,
                ..
            }) if completed_frames >= total_frames
        );
        if !finished {
            return;
        }
        if let Some(phase) = self.phase.take() {
            match phase {
                ProcessorPhase::Crossfading { to, .. }
                | ProcessorPhase::LatencyTransition { to, .. } => {
                    self.phase = Some(ProcessorPhase::Stable(to));
                }
                ProcessorPhase::Stable(processor) => {
                    self.phase = Some(ProcessorPhase::Stable(processor));
                }
            }
        }
    }
}

impl AudioProcessor for LiveEqProcessor {
    fn process(&mut self, interleaved: &mut [f32], channels: u16) {
        if let Some(next) = self.take_pending() {
            self.install(next);
        }
        if channels < 2 {
            return;
        }

        for frame in interleaved.chunks_exact_mut(channels as usize) {
            let left = if frame[0].is_finite() { frame[0] } else { 0.0 };
            let right = if frame[1].is_finite() { frame[1] } else { 0.0 };
            match self
                .phase
                .as_mut()
                .expect("processor phase is always present")
            {
                ProcessorPhase::Stable(processor) => {
                    let (processed_left, processed_right) =
                        processor.process_stereo_frame(left, right);
                    frame[0] = finite_or_silence(processed_left);
                    frame[1] = finite_or_silence(processed_right);
                }
                ProcessorPhase::Crossfading {
                    from,
                    to,
                    completed_frames,
                    total_frames,
                } => {
                    let (old_left, old_right) = from.process_stereo_frame(left, right);
                    let (new_left, new_right) = to.process_stereo_frame(left, right);
                    let mix = (*completed_frames as f32 / *total_frames as f32).clamp(0.0, 1.0);
                    frame[0] = finite_or_silence(old_left + (new_left - old_left) * mix);
                    frame[1] = finite_or_silence(old_right + (new_right - old_right) * mix);
                    *completed_frames = completed_frames.saturating_add(1);
                }
                ProcessorPhase::LatencyTransition {
                    from,
                    to,
                    completed_frames,
                    total_frames,
                } => {
                    let old = from.process_stereo_frame(left, right);
                    let new = to.process_stereo_frame(left, right);
                    let midpoint = (*total_frames / 2).max(1);
                    let (output, gain) = if *completed_frames < midpoint {
                        (old, 1.0 - *completed_frames as f32 / midpoint as f32)
                    } else {
                        let rise_frames = total_frames.saturating_sub(midpoint).max(1);
                        (
                            new,
                            (completed_frames.saturating_sub(midpoint) as f32 / rise_frames as f32)
                                .clamp(0.0, 1.0),
                        )
                    };
                    frame[0] = finite_or_silence(output.0 * gain);
                    frame[1] = finite_or_silence(output.1 * gain);
                    *completed_frames = completed_frames.saturating_add(1);
                }
            }
            self.finish_crossfade_if_ready();
        }
    }
}

fn finite_or_silence(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

pub struct AudioHost {
    #[cfg(windows)]
    backend: WasapiBackend,
    stream: Option<Box<dyn AudioStream>>,
    #[cfg(windows)]
    external_input: Option<ExternalPcmInput>,
    pending_processor: Option<Arc<Mutex<Option<StereoEqProcessor>>>>,
    active_sample_rate_hz: u32,
    active_dsp_latency_frames: u32,
    last_request: Option<NativeStartRequest>,
    last_error: Option<String>,
}

impl Default for AudioHost {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioHost {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            backend: WasapiBackend::new(),
            stream: None,
            #[cfg(windows)]
            external_input: None,
            pending_processor: None,
            active_sample_rate_hz: 0,
            active_dsp_latency_frames: 0,
            last_request: None,
            last_error: None,
        }
    }

    pub fn inventory(&self) -> Result<NativeAudioInventory, String> {
        #[cfg(not(windows))]
        {
            Err("The WASAPI audio host is only available on Windows.".into())
        }
        #[cfg(windows)]
        {
            let input_devices = self.backend.audio_sources().map_err(audio_error)?;
            let output_devices = self.backend.output_devices().map_err(audio_error)?;
            let default_input_id = self
                .backend
                .default_audio_source(AudioSourceKind::SystemLoopback)
                .map_err(audio_error)?
                .map(|device| device.id);
            let default_output_id = self
                .backend
                .default_output_device()
                .map_err(audio_error)?
                .map(|device| device.id);
            let recommended_input_id = input_devices
                .iter()
                .find(|source| {
                    source.kind == AudioSourceKind::SystemLoopback
                        && source.transport == uzjam_audio::DeviceTransport::Virtual
                        && Some(source.id.as_str()) != default_output_id.as_deref()
                })
                .map(|source| source.id.clone());
            Ok(NativeAudioInventory {
                backend: self.backend.backend_name().into(),
                input_devices,
                output_devices,
                default_input_id,
                default_output_id,
                recommended_input_id,
                capabilities: self.backend.capabilities(),
            })
        }
    }

    pub fn start(&mut self, request: NativeStartRequest) -> Result<NativeAudioStatus, String> {
        #[cfg(not(windows))]
        {
            let _ = request;
            Err("The WASAPI audio host is only available on Windows.".into())
        }
        #[cfg(windows)]
        {
            // A failed worker returns its terminal error while joining. Its handles are
            // still released, so recovery must continue instead of treating that prior
            // route error as a failure to stop the replacement route.
            let _ = self.stop_stream();
            validate_profile(&request.profile)?;
            let sources = self.backend.audio_sources().map_err(audio_error)?;
            let source = sources
                .into_iter()
                .find(|source| source.id == request.source_device_id)
                .ok_or_else(|| "The selected capture source is no longer available.".to_string())?;
            let outputs = self.backend.output_devices().map_err(audio_error)?;
            let output = outputs
                .into_iter()
                .find(|device| device.id == request.output_device_id)
                .ok_or_else(|| {
                    "The selected listening output is no longer available.".to_string()
                })?;
            let sample_rate_hz = output
                .supported_sample_rates
                .first()
                .copied()
                .filter(|rate| (8_000..=384_000).contains(rate))
                .unwrap_or(DEFAULT_SAMPLE_RATE_HZ);
            let preferred_buffer_frames = request
                .preferred_buffer_frames
                .unwrap_or(DEFAULT_BUFFER_FRAMES)
                .clamp(64, 4_096);
            let config = StreamConfig {
                sample_rate_hz,
                channels: 2,
                format: SampleFormat::F32,
                exclusive: false,
                preferred_buffer_frames: Some(preferred_buffer_frames),
            };
            let route = AudioRoute {
                source_device_id: source.id,
                source_kind: source.kind,
                output_device_id: output.id,
            };
            let initial = StereoEqProcessor::from_profile(&request.profile, sample_rate_hz as f64)
                .map_err(|error| {
                    format!("The EQ profile cannot run at {sample_rate_hz} Hz: {error:?}")
                })?;
            let dsp_latency_frames = initial.latency_frames() as u32;
            let pending = Arc::new(Mutex::new(None));
            let processor = LiveEqProcessor::new(initial, Arc::clone(&pending), sample_rate_hz);
            let mut stream = self
                .backend
                .open_processing_stream(route, config, Box::new(processor))
                .map_err(audio_error)?;
            if let Err(error) = stream.start() {
                self.last_error = Some(error.to_string());
                return Err(error.to_string());
            }
            self.active_sample_rate_hz = sample_rate_hz;
            self.active_dsp_latency_frames = dsp_latency_frames;
            self.pending_processor = Some(pending);
            self.external_input = None;
            self.stream = Some(stream);
            self.last_request = Some(request);
            self.last_error = None;
            Ok(self.status())
        }
    }

    pub fn start_external(
        &mut self,
        request: ExtensionAudioStartRequest,
    ) -> Result<NativeAudioStatus, String> {
        #[cfg(not(windows))]
        {
            let _ = request;
            Err("Chrome tab audio is currently available on Windows only.".into())
        }
        #[cfg(windows)]
        {
            let _ = self.stop_stream();
            validate_profile(&request.profile)?;
            let output = self
                .backend
                .output_devices()
                .map_err(audio_error)?
                .into_iter()
                .find(|device| device.id == request.output_device_id)
                .ok_or_else(|| {
                    "The selected listening output is no longer available.".to_string()
                })?;
            let sample_rate_hz = output
                .supported_sample_rates
                .first()
                .copied()
                .filter(|rate| (8_000..=384_000).contains(rate))
                .unwrap_or(DEFAULT_SAMPLE_RATE_HZ);
            let preferred_buffer_frames = request
                .preferred_buffer_frames
                .unwrap_or(DEFAULT_BUFFER_FRAMES)
                .clamp(64, 4_096);
            let config = StreamConfig {
                sample_rate_hz,
                channels: 2,
                format: SampleFormat::F32,
                exclusive: false,
                preferred_buffer_frames: Some(preferred_buffer_frames),
            };
            let initial = StereoEqProcessor::from_profile(&request.profile, sample_rate_hz as f64)
                .map_err(|error| {
                    format!("The EQ profile cannot run at {sample_rate_hz} Hz: {error:?}")
                })?;
            let dsp_latency_frames = initial.latency_frames() as u32;
            let pending = Arc::new(Mutex::new(None));
            let processor = LiveEqProcessor::new(initial, Arc::clone(&pending), sample_rate_hz);
            let (mut stream, input) = self
                .backend
                .open_external_processing_stream(output.id, config, Box::new(processor))
                .map_err(audio_error)?;
            if let Err(error) = stream.start() {
                self.last_error = Some(error.to_string());
                return Err(error.to_string());
            }
            self.active_sample_rate_hz = sample_rate_hz;
            self.active_dsp_latency_frames = dsp_latency_frames;
            self.pending_processor = Some(pending);
            self.external_input = Some(input);
            self.stream = Some(stream);
            self.last_request = None;
            self.last_error = None;
            Ok(self.status())
        }
    }

    pub fn push_external_pcm(
        &self,
        samples: Vec<f32>,
        sample_rate_hz: u32,
        channels: u16,
    ) -> Result<(), String> {
        #[cfg(not(windows))]
        {
            let _ = (samples, sample_rate_hz, channels);
            Err("Chrome tab audio is currently available on Windows only.".into())
        }
        #[cfg(windows)]
        {
            let input = self.external_input.as_ref().ok_or_else(|| {
                "Choose Browser tab in UZjam before starting capture in Chrome.".to_string()
            })?;
            input
                .push_interleaved(samples, sample_rate_hz, channels)
                .map_err(audio_error)
        }
    }

    pub fn recover(&mut self) -> Result<NativeAudioStatus, String> {
        let request = self.last_request.clone().ok_or_else(|| {
            "There is no previously working Windows audio route to recover.".to_string()
        })?;
        self.start(request)
    }

    pub fn update_profile(&mut self, profile: UzjamProfile) -> Result<NativeAudioStatus, String> {
        validate_profile(&profile)?;
        let sample_rate_hz = self.active_sample_rate_hz;
        if sample_rate_hz == 0 || self.stream.is_none() {
            return Err("Start the Windows audio engine before updating its profile.".into());
        }
        let next =
            StereoEqProcessor::from_profile(&profile, sample_rate_hz as f64).map_err(|error| {
                format!("The EQ profile cannot run at {sample_rate_hz} Hz: {error:?}")
            })?;
        self.active_dsp_latency_frames = next.latency_frames() as u32;
        let pending = self
            .pending_processor
            .as_ref()
            .ok_or_else(|| "The real-time processor is unavailable.".to_string())?;
        let mut slot = pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(next);
        drop(slot);
        Ok(self.status())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.last_request = None;
        self.stop_stream()
    }

    fn stop_stream(&mut self) -> Result<(), String> {
        let Some(mut stream) = self.stream.take() else {
            self.pending_processor = None;
            #[cfg(windows)]
            {
                self.external_input = None;
            }
            self.active_sample_rate_hz = 0;
            self.active_dsp_latency_frames = 0;
            return Ok(());
        };
        let result = stream.stop().map_err(audio_error);
        self.pending_processor = None;
        #[cfg(windows)]
        {
            self.external_input = None;
        }
        self.active_sample_rate_hz = 0;
        self.active_dsp_latency_frames = 0;
        if let Err(error) = &result {
            self.last_error = Some(error.clone());
        }
        result
    }

    pub fn stop_with_status(&mut self) -> Result<NativeAudioStatus, String> {
        self.stop()?;
        Ok(self.status())
    }

    pub fn status(&mut self) -> NativeAudioStatus {
        let backend_name = self.backend_name().to_string();
        let Some(stream) = self.stream.as_mut() else {
            return NativeAudioStatus::idle(cfg!(windows), &backend_name, self.last_error.clone());
        };
        if let Some(error) = stream.take_error() {
            self.last_error = Some(error.to_string());
        }
        let state = stream.state();
        let telemetry = stream.telemetry();
        let route = stream.route().clone();
        let config = stream.config();
        status_from_stream(
            &backend_name,
            state,
            telemetry,
            route,
            config,
            self.active_dsp_latency_frames,
            self.last_error.clone(),
        )
    }

    fn backend_name(&self) -> &str {
        #[cfg(windows)]
        {
            self.backend.backend_name()
        }
        #[cfg(not(windows))]
        {
            "Native audio unavailable"
        }
    }
}

impl Drop for AudioHost {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn validate_profile(profile: &UzjamProfile) -> Result<(), String> {
    let errors: Vec<String> = profile
        .validate()
        .into_iter()
        .filter(|issue| issue.severity == ValidationSeverity::Error)
        .map(|issue| format!("{}: {}", issue.path, issue.message))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("The EQ profile is invalid: {}", errors.join("; ")))
    }
}

fn status_from_stream(
    backend: &str,
    state: StreamState,
    telemetry: StreamTelemetry,
    route: AudioRoute,
    config: StreamConfig,
    dsp_latency_frames: u32,
    last_error: Option<String>,
) -> NativeAudioStatus {
    let buffer_frames = telemetry
        .capture_buffer_frames
        .max(telemetry.render_buffer_frames)
        .max(config.preferred_buffer_frames.unwrap_or(0));
    let estimated_frames = telemetry.capture_buffer_frames as u64
        + telemetry.render_buffer_frames as u64
        + telemetry.queue_fill_frames as u64
        + dsp_latency_frames as u64;
    let estimated_latency_ms = if telemetry.sample_rate_hz == 0 {
        0.0
    } else {
        estimated_frames as f64 * 1_000.0 / telemetry.sample_rate_hz as f64
    };
    let running = state == StreamState::Running;
    NativeAudioStatus {
        available: true,
        running,
        state,
        backend: backend.into(),
        status_detail: if running && route.source_kind == AudioSourceKind::ExternalStream {
            "Chrome tab audio is passing through Rust DSP to the selected output.".into()
        } else if running {
            "Rust DSP is inserted between the selected Windows endpoints.".into()
        } else if state == StreamState::Failed {
            "The Windows audio route needs attention.".into()
        } else {
            "The Windows audio route is not running.".into()
        },
        source_device_id: Some(route.source_device_id),
        output_device_id: Some(route.output_device_id),
        sample_rate_hz: telemetry.sample_rate_hz,
        channels: telemetry.channels,
        sample_format: "f32",
        buffer_frames,
        estimated_latency_ms,
        queue_fill_frames: telemetry.queue_fill_frames,
        queue_capacity_frames: telemetry.queue_capacity_frames,
        clock_adjustments: telemetry.clock_adjustments,
        xruns: telemetry
            .discontinuities
            .saturating_add(telemetry.dropped_frames)
            .saturating_add(telemetry.underrun_frames),
        dropped_frames: telemetry.dropped_frames,
        underrun_frames: telemetry.underrun_frames,
        discontinuities: telemetry.discontinuities,
        clipped_samples: telemetry.clipped_samples,
        input_peak_dbfs: telemetry.input_peak_dbfs,
        output_peak_dbfs: telemetry.output_peak_dbfs,
        last_error,
    }
}

fn audio_error(error: AudioError) -> String {
    error.to_string()
}
