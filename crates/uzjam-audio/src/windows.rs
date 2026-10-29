//! Thin Windows WASAPI adapter.
//!
//! The real-time route captures either an input endpoint or the shared mix of a
//! render endpoint, invokes the platform-neutral processor, then renders to a
//! different output endpoint. Transparent same-endpoint interception requires
//! an APO or virtual audio driver and is deliberately not claimed here.

use crate::{
    validate_route, AudioBackend, AudioDevice, AudioError, AudioProcessor, AudioRoute, AudioSource,
    AudioSourceKind, AudioStream, DeviceTransport, Platform, PlatformCapabilities, SampleFormat,
    StreamConfig, StreamState, StreamTelemetry, SupportLevel,
};
use bytemuck::{cast_slice, cast_slice_mut};
use rtrb::{Consumer, Producer, RingBuffer};
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wasapi::{
    AudioCaptureClient, AudioClient, AudioRenderClient, Device, DeviceEnumerator, Direction,
    Handle, SampleType, StreamMode, WasapiError, WaveFormat,
};

const START_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_TIMEOUT_MS: u32 = 100;
const MIN_QUEUE_FRAMES: usize = 2_048;
const DEFAULT_TARGET_BUFFER_MS: u32 = 10;

#[derive(Debug, Clone, Copy, Default)]
pub struct WasapiBackend;

impl WasapiBackend {
    pub fn new() -> Self {
        Self
    }

    /// Opens an output stream whose PCM arrives from a trusted process bridge.
    ///
    /// WASAPI stays isolated in this adapter: the desktop host only supplies
    /// interleaved float samples and the platform-neutral DSP processor.
    pub fn open_external_processing_stream(
        &self,
        output_device_id: String,
        config: StreamConfig,
        processor: Box<dyn AudioProcessor>,
    ) -> Result<(Box<dyn AudioStream>, ExternalPcmInput), AudioError> {
        if output_device_id.trim().is_empty() {
            return Err(AudioError::DeviceNotFound(
                "output endpoint id is empty".into(),
            ));
        }
        if config.format != SampleFormat::F32 {
            return Err(AudioError::UnsupportedConfiguration(
                "the external WASAPI route accepts interleaved f32 PCM only".into(),
            ));
        }
        if config.channels != 2 {
            return Err(AudioError::UnsupportedConfiguration(
                "the external WASAPI route currently renders stereo PCM".into(),
            ));
        }
        if config.exclusive {
            return Err(AudioError::UnsupportedConfiguration(
                "the browser-tab route uses shared-mode WASAPI output".into(),
            ));
        }
        let route = AudioRoute {
            source_device_id: "uzjam-browser-extension".into(),
            source_kind: AudioSourceKind::ExternalStream,
            output_device_id,
        };
        let (stream, input) = WasapiExternalStream::new(route, config, processor);
        Ok((Box::new(stream), input))
    }
}

impl AudioBackend for WasapiBackend {
    fn platform(&self) -> Platform {
        Platform::Windows
    }

    fn backend_name(&self) -> &'static str {
        "Windows WASAPI"
    }

    fn capabilities(&self) -> PlatformCapabilities {
        PlatformCapabilities {
            // Loopback routing works today, but transparent interception needs a virtual device/APO.
            system_wide_eq: SupportLevel::Partial,
            // The shipping source -> processor -> output path is shared-mode only.
            exclusive_mode: SupportLevel::Unsupported,
            usb_direct: SupportLevel::Partial,
            app_specific_eq: SupportLevel::Unsupported,
            high_resolution_audio: SupportLevel::Supported,
            device_switching: SupportLevel::Supported,
            channel_routing: SupportLevel::Supported,
        }
    }

    fn output_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        on_mta_thread("enumerate WASAPI output devices", || {
            enumerate_devices(Direction::Render)
        })
    }

    fn default_output_device(&self) -> Result<Option<AudioDevice>, AudioError> {
        on_mta_thread("read the default WASAPI output", || {
            default_device(Direction::Render)
        })
    }

    fn audio_sources(&self) -> Result<Vec<AudioSource>, AudioError> {
        on_mta_thread("enumerate WASAPI audio sources", || {
            let mut sources = enumerate_sources(Direction::Capture, AudioSourceKind::Input)?;
            sources.extend(enumerate_sources(
                Direction::Render,
                AudioSourceKind::SystemLoopback,
            )?);
            sources.sort_by(|left, right| {
                right
                    .is_default
                    .cmp(&left.is_default)
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                    .then_with(|| left.kind.cmp(&right.kind))
            });
            Ok(sources)
        })
    }

    fn default_audio_source(
        &self,
        kind: AudioSourceKind,
    ) -> Result<Option<AudioSource>, AudioError> {
        on_mta_thread("read the default WASAPI source", move || {
            let direction = match kind {
                AudioSourceKind::Input => Direction::Capture,
                AudioSourceKind::SystemLoopback => Direction::Render,
                AudioSourceKind::ExternalStream => return Ok(None),
            };
            Ok(default_device(direction)?.map(|device| source_from_device(device, kind)))
        })
    }

    fn open_processing_stream(
        &self,
        route: AudioRoute,
        config: StreamConfig,
        processor: Box<dyn AudioProcessor>,
    ) -> Result<Box<dyn AudioStream>, AudioError> {
        validate_route(&route, config)?;
        if config.format != SampleFormat::F32 {
            return Err(AudioError::UnsupportedConfiguration(
                "the WASAPI real-time route currently accepts interleaved f32 PCM only".into(),
            ));
        }
        if config.exclusive {
            return Err(AudioError::UnsupportedConfiguration(
                "exclusive mode is not available for the source-to-output route; WASAPI loopback capture is shared-mode only".into(),
            ));
        }
        Ok(Box::new(WasapiStream::new(route, config, processor)))
    }
}

fn enumerate_devices(direction: Direction) -> Result<Vec<AudioDevice>, AudioError> {
    let enumerator =
        DeviceEnumerator::new().map_err(|error| backend_error("create enumerator", error))?;
    let default_id = match enumerator.get_default_device(&direction) {
        Ok(device) => Some(
            device
                .get_id()
                .map_err(|error| backend_error("read default endpoint id", error))?,
        ),
        Err(error) if is_endpoint_not_found(&error) => None,
        Err(error) => return Err(backend_error("read default endpoint", error)),
    };
    let collection = enumerator
        .get_device_collection(&direction)
        .map_err(|error| backend_error("enumerate active endpoints", error))?;
    let mut devices = Vec::new();
    for device in &collection {
        let device = device.map_err(|error| backend_error("read endpoint", error))?;
        devices.push(describe_device(&device, default_id.as_deref())?);
    }
    devices.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(devices)
}

fn enumerate_sources(
    direction: Direction,
    kind: AudioSourceKind,
) -> Result<Vec<AudioSource>, AudioError> {
    enumerate_devices(direction).map(|devices| {
        devices
            .into_iter()
            .map(|device| source_from_device(device, kind))
            .collect()
    })
}

fn default_device(direction: Direction) -> Result<Option<AudioDevice>, AudioError> {
    let enumerator =
        DeviceEnumerator::new().map_err(|error| backend_error("create enumerator", error))?;
    let device = match enumerator.get_default_device(&direction) {
        Ok(device) => device,
        Err(error) if is_endpoint_not_found(&error) => return Ok(None),
        Err(error) => return Err(backend_error("read default endpoint", error)),
    };
    Ok(Some(describe_device(
        &device,
        device.get_id().ok().as_deref(),
    )?))
}

fn describe_device(device: &Device, default_id: Option<&str>) -> Result<AudioDevice, AudioError> {
    let id = device
        .get_id()
        .map_err(|error| backend_error("read endpoint id", error))?;
    let name = device
        .get_friendlyname()
        .map_err(|error| backend_error("read endpoint name", error))?;
    let manufacturer = device
        .get_interface_friendlyname()
        .ok()
        .filter(|value| !value.trim().is_empty() && value != &name);
    let format = device
        .get_iaudioclient()
        .and_then(|client| client.get_mixformat())
        .or_else(|_| device.get_device_format())
        .map_err(|error| backend_error("read endpoint mix format", error))?;
    let valid_bits = format.get_validbitspersample();
    let stored_bits = format.get_bitspersample();
    let bit_depth = if valid_bits == 0 {
        stored_bits
    } else {
        valid_bits
    };
    let transport = infer_transport(&format!(
        "{} {}",
        name,
        manufacturer.as_deref().unwrap_or_default()
    ));

    Ok(AudioDevice {
        is_default: default_id == Some(id.as_str()),
        id,
        name,
        manufacturer,
        transport,
        max_channels: format.get_nchannels(),
        supported_sample_rates: vec![format.get_samplespersec()],
        supported_bit_depths: vec![bit_depth],
    })
}

fn source_from_device(device: AudioDevice, kind: AudioSourceKind) -> AudioSource {
    AudioSource {
        id: device.id,
        name: device.name,
        manufacturer: device.manufacturer,
        transport: device.transport,
        is_default: device.is_default,
        max_channels: device.max_channels,
        supported_sample_rates: device.supported_sample_rates,
        supported_bit_depths: device.supported_bit_depths,
        kind,
    }
}

fn infer_transport(description: &str) -> DeviceTransport {
    let value = description.to_ascii_lowercase();
    if value.contains("bluetooth") {
        DeviceTransport::Bluetooth
    } else if value.contains("usb") {
        DeviceTransport::Usb
    } else if value.contains("hdmi") || value.contains("displayport") {
        DeviceTransport::Hdmi
    } else if ["virtual", "cable", "voicemeeter", "loopback"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        DeviceTransport::Virtual
    } else if value.contains("network") || value.contains("remote audio") {
        DeviceTransport::Network
    } else if value.contains("built-in") || value.contains("realtek") {
        DeviceTransport::BuiltIn
    } else {
        DeviceTransport::Unknown
    }
}

struct ComGuard;

impl ComGuard {
    fn initialize() -> Result<Self, AudioError> {
        wasapi::initialize_mta()
            .ok()
            .map_err(|error| AudioError::BackendUnavailable(format!("initialize COM: {error}")))?;
        Ok(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

fn on_mta_thread<T, F>(operation: &'static str, task: F) -> Result<T, AudioError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AudioError> + Send + 'static,
{
    thread::Builder::new()
        .name("uzjam-wasapi-query".into())
        .spawn(move || {
            let _com = ComGuard::initialize()?;
            task()
        })
        .map_err(|error| AudioError::BackendUnavailable(format!("{operation}: {error}")))?
        .join()
        .map_err(|_| AudioError::BackendUnavailable(format!("{operation}: worker panicked")))?
}

fn backend_error(context: &str, error: WasapiError) -> AudioError {
    AudioError::BackendUnavailable(format!("{context}: {error}"))
}

fn stream_error(context: &str, error: WasapiError) -> AudioError {
    if is_access_denied(&error) {
        AudioError::PermissionDenied(format!("{context}: {error}"))
    } else {
        AudioError::StreamFailure(format!("{context}: {error}"))
    }
}

fn is_endpoint_not_found(error: &WasapiError) -> bool {
    matches!(error, WasapiError::DeviceNotFound(_))
        || windows_error_code(error) == Some(0x8007_0490)
}

fn is_access_denied(error: &WasapiError) -> bool {
    windows_error_code(error) == Some(0x8007_0005)
}

fn windows_error_code(error: &WasapiError) -> Option<u32> {
    match error {
        WasapiError::Windows(error) => Some(error.code().0 as u32),
        _ => None,
    }
}

struct SharedTelemetry {
    sample_rate_hz: u32,
    channels: u16,
    capture_buffer_frames: AtomicU32,
    render_buffer_frames: AtomicU32,
    queue_capacity_frames: u32,
    queue_fill_frames: AtomicU32,
    clock_adjustments: AtomicU64,
    captured_frames: AtomicU64,
    rendered_frames: AtomicU64,
    dropped_frames: AtomicU64,
    underrun_frames: AtomicU64,
    discontinuities: AtomicU64,
    clipped_samples: AtomicU64,
    input_peak_bits: AtomicU32,
    output_peak_bits: AtomicU32,
}

impl SharedTelemetry {
    fn new(config: StreamConfig, queue_capacity_frames: u32) -> Self {
        Self {
            sample_rate_hz: config.sample_rate_hz,
            channels: config.channels,
            capture_buffer_frames: AtomicU32::new(0),
            render_buffer_frames: AtomicU32::new(0),
            queue_capacity_frames,
            queue_fill_frames: AtomicU32::new(0),
            clock_adjustments: AtomicU64::new(0),
            captured_frames: AtomicU64::new(0),
            rendered_frames: AtomicU64::new(0),
            dropped_frames: AtomicU64::new(0),
            underrun_frames: AtomicU64::new(0),
            discontinuities: AtomicU64::new(0),
            clipped_samples: AtomicU64::new(0),
            input_peak_bits: AtomicU32::new((-120.0_f32).to_bits()),
            output_peak_bits: AtomicU32::new((-120.0_f32).to_bits()),
        }
    }

    fn snapshot(&self, state: StreamState) -> StreamTelemetry {
        StreamTelemetry {
            state,
            sample_rate_hz: self.sample_rate_hz,
            channels: self.channels,
            capture_buffer_frames: self.capture_buffer_frames.load(Ordering::Relaxed),
            render_buffer_frames: self.render_buffer_frames.load(Ordering::Relaxed),
            queue_capacity_frames: self.queue_capacity_frames,
            queue_fill_frames: self.queue_fill_frames.load(Ordering::Relaxed),
            clock_adjustments: self.clock_adjustments.load(Ordering::Relaxed),
            captured_frames: self.captured_frames.load(Ordering::Relaxed),
            rendered_frames: self.rendered_frames.load(Ordering::Relaxed),
            dropped_frames: self.dropped_frames.load(Ordering::Relaxed),
            underrun_frames: self.underrun_frames.load(Ordering::Relaxed),
            discontinuities: self.discontinuities.load(Ordering::Relaxed),
            clipped_samples: self.clipped_samples.load(Ordering::Relaxed),
            input_peak_dbfs: f32::from_bits(self.input_peak_bits.load(Ordering::Relaxed)),
            output_peak_dbfs: f32::from_bits(self.output_peak_bits.load(Ordering::Relaxed)),
        }
    }

    fn reset(&self) {
        self.capture_buffer_frames.store(0, Ordering::Relaxed);
        self.render_buffer_frames.store(0, Ordering::Relaxed);
        self.queue_fill_frames.store(0, Ordering::Relaxed);
        self.clock_adjustments.store(0, Ordering::Relaxed);
        self.captured_frames.store(0, Ordering::Relaxed);
        self.rendered_frames.store(0, Ordering::Relaxed);
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.underrun_frames.store(0, Ordering::Relaxed);
        self.discontinuities.store(0, Ordering::Relaxed);
        self.clipped_samples.store(0, Ordering::Relaxed);
        self.input_peak_bits
            .store((-120.0_f32).to_bits(), Ordering::Relaxed);
        self.output_peak_bits
            .store((-120.0_f32).to_bits(), Ordering::Relaxed);
    }
}

pub struct WasapiStream {
    route: AudioRoute,
    config: StreamConfig,
    processor: Option<Box<dyn AudioProcessor>>,
    stop_requested: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    telemetry: Arc<SharedTelemetry>,
    last_error: Arc<Mutex<Option<AudioError>>>,
    worker: Option<JoinHandle<WorkerExit>>,
}

impl WasapiStream {
    fn new(route: AudioRoute, config: StreamConfig, processor: Box<dyn AudioProcessor>) -> Self {
        let queue_capacity_frames = queue_capacity_frames(config);
        Self {
            route,
            config,
            processor: Some(processor),
            stop_requested: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(StreamState::Idle as u8)),
            telemetry: Arc::new(SharedTelemetry::new(config, queue_capacity_frames as u32)),
            last_error: Arc::new(Mutex::new(None)),
            worker: None,
        }
    }

    fn restore_finished_worker(&mut self) -> Result<(), AudioError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        let exit = worker
            .join()
            .map_err(|_| AudioError::StreamFailure("WASAPI processing worker panicked".into()))?;
        self.processor = Some(exit.processor);
        exit.result
    }

    fn set_last_error(&self, error: AudioError) {
        *self
            .last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
    }
}

impl AudioStream for WasapiStream {
    fn route(&self) -> &AudioRoute {
        &self.route
    }

    fn config(&self) -> StreamConfig {
        self.config
    }

    fn start(&mut self) -> Result<(), AudioError> {
        match self.state() {
            StreamState::Running | StreamState::Starting => return Ok(()),
            StreamState::Stopping => {
                return Err(AudioError::InvalidState(
                    "cannot start while the stream is stopping".into(),
                ));
            }
            StreamState::Idle | StreamState::Stopped | StreamState::Failed => {}
        }

        if self.worker.is_some() {
            let _ = self.restore_finished_worker();
        }
        let processor = self.processor.take().ok_or_else(|| {
            AudioError::InvalidState("the stream processor is unavailable".into())
        })?;

        self.stop_requested.store(false, Ordering::Release);
        self.telemetry.reset();
        self.state
            .store(StreamState::Starting as u8, Ordering::Release);
        *self
            .last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;

        let route = self.route.clone();
        let config = self.config;
        let stop_requested = Arc::clone(&self.stop_requested);
        let state = Arc::clone(&self.state);
        let telemetry = Arc::clone(&self.telemetry);
        let last_error = Arc::clone(&self.last_error);
        let (started_tx, started_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("uzjam-wasapi-capture".into())
            .spawn(move || {
                worker_entry(
                    route,
                    config,
                    processor,
                    stop_requested,
                    state,
                    telemetry,
                    last_error,
                    started_tx,
                )
            })
            .map_err(|error| {
                self.state
                    .store(StreamState::Failed as u8, Ordering::Release);
                AudioError::StreamFailure(format!("start WASAPI worker: {error}"))
            })?;
        self.worker = Some(worker);

        match started_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.stop_requested.store(true, Ordering::Release);
                let _ = self.restore_finished_worker();
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let error = AudioError::Timeout(
                    "WASAPI endpoints did not become ready within 5 seconds".into(),
                );
                self.stop_requested.store(true, Ordering::Release);
                self.state
                    .store(StreamState::Failed as u8, Ordering::Release);
                self.set_last_error(error.clone());
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.stop_requested.store(true, Ordering::Release);
                let error = self.take_error().unwrap_or_else(|| {
                    AudioError::StreamFailure(
                        "WASAPI worker exited before reporting readiness".into(),
                    )
                });
                let _ = self.restore_finished_worker();
                Err(error)
            }
        }
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        if self.worker.is_none() {
            self.state
                .store(StreamState::Stopped as u8, Ordering::Release);
            return Ok(());
        }
        self.state
            .store(StreamState::Stopping as u8, Ordering::Release);
        self.stop_requested.store(true, Ordering::Release);
        let result = self.restore_finished_worker();
        if result.is_ok() {
            self.state
                .store(StreamState::Stopped as u8, Ordering::Release);
        } else {
            self.state
                .store(StreamState::Failed as u8, Ordering::Release);
        }
        result
    }

    fn state(&self) -> StreamState {
        decode_state(self.state.load(Ordering::Acquire))
    }

    fn telemetry(&self) -> StreamTelemetry {
        self.telemetry.snapshot(self.state())
    }

    fn take_error(&mut self) -> Option<AudioError> {
        self.last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

impl Drop for WasapiStream {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct WorkerExit {
    processor: Box<dyn AudioProcessor>,
    result: Result<(), AudioError>,
}

#[allow(clippy::too_many_arguments)]
fn worker_entry(
    route: AudioRoute,
    config: StreamConfig,
    mut processor: Box<dyn AudioProcessor>,
    stop_requested: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    telemetry: Arc<SharedTelemetry>,
    last_error: Arc<Mutex<Option<AudioError>>>,
    started_tx: mpsc::Sender<Result<(), AudioError>>,
) -> WorkerExit {
    let mut started_tx = Some(started_tx);
    let result = run_route(
        &route,
        config,
        processor.as_mut(),
        &stop_requested,
        &state,
        &telemetry,
        &mut started_tx,
    );
    processor.stopped();
    stop_requested.store(true, Ordering::Release);

    match &result {
        Ok(()) => {
            if decode_state(state.load(Ordering::Acquire)) != StreamState::Failed {
                state.store(StreamState::Stopped as u8, Ordering::Release);
            }
        }
        Err(error) => {
            state.store(StreamState::Failed as u8, Ordering::Release);
            *last_error
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.clone());
            if let Some(sender) = started_tx.take() {
                let _ = sender.send(Err(error.clone()));
            }
        }
    }

    WorkerExit { processor, result }
}

fn run_route(
    route: &AudioRoute,
    config: StreamConfig,
    processor: &mut dyn AudioProcessor,
    stop_requested: &AtomicBool,
    state: &AtomicU8,
    telemetry: &Arc<SharedTelemetry>,
    started_tx: &mut Option<mpsc::Sender<Result<(), AudioError>>>,
) -> Result<(), AudioError> {
    let _com = ComGuard::initialize()?;
    processor.prepare(&config)?;

    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        config.sample_rate_hz as usize,
        config.channels as usize,
        None,
    );
    let queue_samples = telemetry.queue_capacity_frames as usize * config.channels as usize;
    let (producer, consumer) = RingBuffer::<f32>::new(queue_samples);
    let (render_ready_tx, render_ready_rx) = mpsc::channel();
    let output_id = route.output_device_id.clone();
    let render_stop = Arc::new(AtomicBool::new(false));
    let render_stop_for_thread = Arc::clone(&render_stop);
    let shared_stop = Arc::new(AtomicBool::new(false));
    let shared_stop_for_thread = Arc::clone(&shared_stop);
    let render_telemetry = Arc::clone(telemetry);
    let render_format = format.clone();
    let render_task = RenderThreadTask {
        output_device_id: output_id,
        config,
        format: render_format,
        consumer,
        stop_requested: render_stop_for_thread,
        capture_stopped: shared_stop_for_thread,
        telemetry: render_telemetry,
        ready_tx: render_ready_tx,
    };
    let render_thread = thread::Builder::new()
        .name("uzjam-wasapi-render".into())
        .spawn(move || render_task.run())
        .map_err(|error| AudioError::StreamFailure(format!("start render worker: {error}")))?;

    let mut capture = match CaptureEndpoint::open(route, config, &format) {
        Ok(capture) => capture,
        Err(error) => {
            render_stop.store(true, Ordering::Release);
            shared_stop.store(true, Ordering::Release);
            let _ = render_thread.join();
            return Err(error);
        }
    };
    telemetry
        .capture_buffer_frames
        .store(capture.buffer_frames, Ordering::Relaxed);

    let render_buffer_frames = match render_ready_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(frames)) => frames,
        Ok(Err(error)) => {
            render_stop.store(true, Ordering::Release);
            shared_stop.store(true, Ordering::Release);
            let _ = render_thread.join();
            return Err(error);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            render_stop.store(true, Ordering::Release);
            shared_stop.store(true, Ordering::Release);
            let _ = render_thread.join();
            return Err(AudioError::Timeout(
                "WASAPI output endpoint did not become ready within 5 seconds".into(),
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            render_stop.store(true, Ordering::Release);
            shared_stop.store(true, Ordering::Release);
            let _ = render_thread.join();
            return Err(AudioError::StreamFailure(
                "WASAPI render worker exited during startup".into(),
            ));
        }
    };
    telemetry
        .render_buffer_frames
        .store(render_buffer_frames, Ordering::Relaxed);

    if let Err(error) = capture.start() {
        render_stop.store(true, Ordering::Release);
        shared_stop.store(true, Ordering::Release);
        let _ = render_thread.join();
        return Err(error);
    }
    state.store(StreamState::Running as u8, Ordering::Release);
    if let Some(sender) = started_tx.take() {
        let _ = sender.send(Ok(()));
    }

    let capture_result = capture.run(
        config,
        processor,
        producer,
        stop_requested,
        &shared_stop,
        telemetry,
    );
    render_stop.store(true, Ordering::Release);
    shared_stop.store(true, Ordering::Release);
    let render_result = render_thread
        .join()
        .map_err(|_| AudioError::StreamFailure("WASAPI render worker panicked".into()))?;
    capture_result.and(render_result)
}

struct CaptureEndpoint {
    audio_client: AudioClient,
    capture_client: AudioCaptureClient,
    event: Handle,
    buffer_frames: u32,
}

impl CaptureEndpoint {
    fn open(
        route: &AudioRoute,
        config: StreamConfig,
        format: &WaveFormat,
    ) -> Result<Self, AudioError> {
        let enumerator =
            DeviceEnumerator::new().map_err(|error| stream_error("create enumerator", error))?;
        let device = enumerator
            .get_device(&route.source_device_id)
            .map_err(|error| AudioError::DeviceNotFound(format!("source endpoint: {error}")))?;
        let expected_direction = match route.source_kind {
            AudioSourceKind::Input => Direction::Capture,
            AudioSourceKind::SystemLoopback => Direction::Render,
            AudioSourceKind::ExternalStream => {
                return Err(AudioError::UnsupportedConfiguration(
                    "external PCM must use the external WASAPI stream".into(),
                ));
            }
        };
        if device.get_direction() != expected_direction {
            return Err(AudioError::UnsupportedConfiguration(format!(
                "source endpoint direction does not match {:?}",
                route.source_kind
            )));
        }

        let mut audio_client = device
            .get_iaudioclient()
            .map_err(|error| stream_error("open source endpoint", error))?;
        let buffer_duration_hns = buffer_duration_hns(&audio_client, config)?;
        audio_client
            .initialize_client(
                format,
                &Direction::Capture,
                &StreamMode::EventsShared {
                    autoconvert: true,
                    buffer_duration_hns,
                },
            )
            .map_err(|error| stream_error("initialize source endpoint", error))?;
        let event = audio_client
            .set_get_eventhandle()
            .map_err(|error| stream_error("create source event", error))?;
        let buffer_frames = audio_client
            .get_buffer_size()
            .map_err(|error| stream_error("read source buffer size", error))?;
        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|error| stream_error("open capture client", error))?;
        Ok(Self {
            audio_client,
            capture_client,
            event,
            buffer_frames,
        })
    }

    fn start(&self) -> Result<(), AudioError> {
        self.audio_client
            .start_stream()
            .map_err(|error| stream_error("start source stream", error))
    }

    fn run(
        &mut self,
        config: StreamConfig,
        processor: &mut dyn AudioProcessor,
        mut producer: Producer<f32>,
        stop_requested: &AtomicBool,
        render_stopped: &AtomicBool,
        telemetry: &SharedTelemetry,
    ) -> Result<(), AudioError> {
        let _stop_guard = StopGuard(&self.audio_client);
        let channels = config.channels as usize;
        let initial_samples = self.buffer_frames as usize * channels;
        let mut samples = vec![0.0_f32; initial_samples.max(channels)];

        while !stop_requested.load(Ordering::Acquire) && !render_stopped.load(Ordering::Acquire) {
            if self.event.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
                continue;
            }
            loop {
                let packet_frames = self
                    .capture_client
                    .get_next_packet_size()
                    .map_err(|error| stream_error("read source packet size", error))?
                    .unwrap_or(self.buffer_frames);
                if packet_frames == 0 {
                    break;
                }
                let needed = packet_frames as usize * channels;
                if samples.len() < needed {
                    samples.resize(needed, 0.0);
                }
                let (frames_read, info) = self
                    .capture_client
                    .read_from_device(cast_slice_mut(&mut samples[..needed]))
                    .map_err(|error| stream_error("capture source audio", error))?;
                let sample_count = frames_read as usize * channels;
                if info.flags.silent {
                    samples[..sample_count].fill(0.0);
                }
                if info.flags.data_discontinuity {
                    telemetry.discontinuities.fetch_add(1, Ordering::Relaxed);
                }
                telemetry.input_peak_bits.store(
                    peak_dbfs(&samples[..sample_count]).to_bits(),
                    Ordering::Relaxed,
                );

                let process_result = catch_unwind(AssertUnwindSafe(|| {
                    processor.process(&mut samples[..sample_count], config.channels);
                }));
                if process_result.is_err() {
                    return Err(AudioError::ProcessorFailure(
                        "the real-time processor panicked; audio was stopped".into(),
                    ));
                }

                let mut clipped = 0_u64;
                for sample in &mut samples[..sample_count] {
                    if !sample.is_finite() {
                        *sample = 0.0;
                    } else if sample.abs() > 1.0 {
                        clipped += 1;
                    }
                }
                telemetry
                    .clipped_samples
                    .fetch_add(clipped, Ordering::Relaxed);
                telemetry.output_peak_bits.store(
                    peak_dbfs(&samples[..sample_count]).to_bits(),
                    Ordering::Relaxed,
                );
                telemetry
                    .captured_frames
                    .fetch_add(frames_read as u64, Ordering::Relaxed);

                let writable_samples = (producer.slots() / channels) * channels;
                let pushed_samples = writable_samples.min(sample_count);
                if pushed_samples > 0 {
                    producer
                        .push_entire_slice(&samples[..pushed_samples])
                        .map_err(|_| {
                            AudioError::StreamFailure(
                                "real-time queue changed unexpectedly while writing".into(),
                            )
                        })?;
                }
                let dropped_samples = sample_count - pushed_samples;
                telemetry
                    .dropped_frames
                    .fetch_add((dropped_samples / channels) as u64, Ordering::Relaxed);
            }
        }
        Ok(())
    }
}

const EXTERNAL_PACKET_QUEUE: usize = 96;
const MAX_EXTERNAL_PACKET_SAMPLES: usize = 262_144;

struct ExternalPcmPacket {
    samples: Vec<f32>,
    sample_rate_hz: u32,
    channels: u16,
}

/// Non-blocking input handle for a WASAPI stream backed by external PCM.
///
/// A full queue drops the newest packet instead of blocking the browser bridge
/// or the real-time render worker.
#[derive(Clone)]
pub struct ExternalPcmInput {
    sender: mpsc::SyncSender<ExternalPcmPacket>,
    telemetry: Arc<SharedTelemetry>,
    accepting: Arc<AtomicBool>,
}

impl ExternalPcmInput {
    pub fn push_interleaved(
        &self,
        samples: Vec<f32>,
        sample_rate_hz: u32,
        channels: u16,
    ) -> Result<(), AudioError> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(AudioError::InvalidState(
                "the external audio route is not running".into(),
            ));
        }
        if !(8_000..=384_000).contains(&sample_rate_hz) {
            return Err(AudioError::UnsupportedConfiguration(format!(
                "external sample rate {sample_rate_hz} Hz is outside the supported range"
            )));
        }
        if channels == 0 || channels > 8 {
            return Err(AudioError::UnsupportedConfiguration(format!(
                "external channel count {channels} is unsupported"
            )));
        }
        if samples.is_empty()
            || samples.len() > MAX_EXTERNAL_PACKET_SAMPLES
            || !samples.len().is_multiple_of(channels as usize)
        {
            return Err(AudioError::UnsupportedConfiguration(
                "external PCM packet has an invalid length".into(),
            ));
        }
        let frames = samples.len() / channels as usize;
        match self.sender.try_send(ExternalPcmPacket {
            samples,
            sample_rate_hz,
            channels,
        }) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => {
                self.telemetry
                    .dropped_frames
                    .fetch_add(frames as u64, Ordering::Relaxed);
                Ok(())
            }
            Err(mpsc::TrySendError::Disconnected(_)) => Err(AudioError::InvalidState(
                "the external audio route has stopped".into(),
            )),
        }
    }
}

struct WasapiExternalStream {
    route: AudioRoute,
    config: StreamConfig,
    processor: Option<Box<dyn AudioProcessor>>,
    receiver: Option<mpsc::Receiver<ExternalPcmPacket>>,
    input: ExternalPcmInput,
    stop_requested: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    telemetry: Arc<SharedTelemetry>,
    last_error: Arc<Mutex<Option<AudioError>>>,
    worker: Option<JoinHandle<WorkerExit>>,
}

impl WasapiExternalStream {
    fn new(
        route: AudioRoute,
        config: StreamConfig,
        processor: Box<dyn AudioProcessor>,
    ) -> (Self, ExternalPcmInput) {
        let telemetry = Arc::new(SharedTelemetry::new(
            config,
            queue_capacity_frames(config) as u32,
        ));
        let accepting = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(EXTERNAL_PACKET_QUEUE);
        let input = ExternalPcmInput {
            sender,
            telemetry: Arc::clone(&telemetry),
            accepting: Arc::clone(&accepting),
        };
        (
            Self {
                route,
                config,
                processor: Some(processor),
                receiver: Some(receiver),
                input: input.clone(),
                stop_requested: Arc::new(AtomicBool::new(false)),
                state: Arc::new(AtomicU8::new(StreamState::Idle as u8)),
                telemetry,
                last_error: Arc::new(Mutex::new(None)),
                worker: None,
            },
            input,
        )
    }

    fn restore_finished_worker(&mut self) -> Result<(), AudioError> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        let exit = worker
            .join()
            .map_err(|_| AudioError::StreamFailure("external WASAPI worker panicked".into()))?;
        self.processor = Some(exit.processor);
        exit.result
    }
}

impl AudioStream for WasapiExternalStream {
    fn route(&self) -> &AudioRoute {
        &self.route
    }

    fn config(&self) -> StreamConfig {
        self.config
    }

    fn start(&mut self) -> Result<(), AudioError> {
        if matches!(self.state(), StreamState::Running | StreamState::Starting) {
            return Ok(());
        }
        let processor = self.processor.take().ok_or_else(|| {
            AudioError::InvalidState("the external stream cannot be restarted".into())
        })?;
        let receiver = self.receiver.take().ok_or_else(|| {
            AudioError::InvalidState("the external PCM receiver is unavailable".into())
        })?;
        self.stop_requested.store(false, Ordering::Release);
        self.telemetry.reset();
        self.state
            .store(StreamState::Starting as u8, Ordering::Release);
        *self
            .last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;

        let route = self.route.clone();
        let config = self.config;
        let stop_requested = Arc::clone(&self.stop_requested);
        let state = Arc::clone(&self.state);
        let telemetry = Arc::clone(&self.telemetry);
        let last_error = Arc::clone(&self.last_error);
        let accepting = Arc::clone(&self.input.accepting);
        let (started_tx, started_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("uzjam-browser-audio".into())
            .spawn(move || {
                external_worker_entry(
                    route,
                    config,
                    processor,
                    receiver,
                    stop_requested,
                    state,
                    telemetry,
                    last_error,
                    accepting,
                    started_tx,
                )
            })
            .map_err(|error| AudioError::StreamFailure(format!("start browser audio: {error}")))?;
        self.worker = Some(worker);

        match started_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.stop_requested.store(true, Ordering::Release);
                let _ = self.restore_finished_worker();
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.stop_requested.store(true, Ordering::Release);
                Err(AudioError::Timeout(
                    "the selected output did not become ready within 5 seconds".into(),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.stop_requested.store(true, Ordering::Release);
                let error = self.take_error().unwrap_or_else(|| {
                    AudioError::StreamFailure("browser audio stopped during startup".into())
                });
                let _ = self.restore_finished_worker();
                Err(error)
            }
        }
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        self.input.accepting.store(false, Ordering::Release);
        self.stop_requested.store(true, Ordering::Release);
        if self.worker.is_none() {
            self.state
                .store(StreamState::Stopped as u8, Ordering::Release);
            return Ok(());
        }
        self.state
            .store(StreamState::Stopping as u8, Ordering::Release);
        let result = self.restore_finished_worker();
        self.state.store(
            if result.is_ok() {
                StreamState::Stopped
            } else {
                StreamState::Failed
            } as u8,
            Ordering::Release,
        );
        result
    }

    fn state(&self) -> StreamState {
        decode_state(self.state.load(Ordering::Acquire))
    }

    fn telemetry(&self) -> StreamTelemetry {
        self.telemetry.snapshot(self.state())
    }

    fn take_error(&mut self) -> Option<AudioError> {
        self.last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

impl Drop for WasapiExternalStream {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[allow(clippy::too_many_arguments)]
fn external_worker_entry(
    route: AudioRoute,
    config: StreamConfig,
    mut processor: Box<dyn AudioProcessor>,
    receiver: mpsc::Receiver<ExternalPcmPacket>,
    stop_requested: Arc<AtomicBool>,
    state: Arc<AtomicU8>,
    telemetry: Arc<SharedTelemetry>,
    last_error: Arc<Mutex<Option<AudioError>>>,
    accepting: Arc<AtomicBool>,
    started_tx: mpsc::Sender<Result<(), AudioError>>,
) -> WorkerExit {
    let mut started_tx = Some(started_tx);
    let result = run_external_route(
        &route,
        config,
        processor.as_mut(),
        receiver,
        &stop_requested,
        &state,
        &telemetry,
        &accepting,
        &mut started_tx,
    );
    processor.stopped();
    accepting.store(false, Ordering::Release);
    stop_requested.store(true, Ordering::Release);
    match &result {
        Ok(()) => state.store(StreamState::Stopped as u8, Ordering::Release),
        Err(error) => {
            state.store(StreamState::Failed as u8, Ordering::Release);
            *last_error
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.clone());
            if let Some(sender) = started_tx.take() {
                let _ = sender.send(Err(error.clone()));
            }
        }
    }
    WorkerExit { processor, result }
}

#[allow(clippy::too_many_arguments)]
fn run_external_route(
    route: &AudioRoute,
    config: StreamConfig,
    processor: &mut dyn AudioProcessor,
    receiver: mpsc::Receiver<ExternalPcmPacket>,
    stop_requested: &AtomicBool,
    state: &AtomicU8,
    telemetry: &SharedTelemetry,
    accepting: &AtomicBool,
    started_tx: &mut Option<mpsc::Sender<Result<(), AudioError>>>,
) -> Result<(), AudioError> {
    let _com = ComGuard::initialize()?;
    processor.prepare(&config)?;
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        config.sample_rate_hz as usize,
        config.channels as usize,
        None,
    );
    let endpoint = RenderEndpoint::open(&route.output_device_id, config, &format)?;
    endpoint.start_with_silence(config.channels as usize)?;
    let _stop_guard = StopGuard(&endpoint.audio_client);
    telemetry
        .render_buffer_frames
        .store(endpoint.buffer_frames, Ordering::Relaxed);
    telemetry.capture_buffer_frames.store(
        config.preferred_buffer_frames.unwrap_or(128),
        Ordering::Relaxed,
    );
    accepting.store(true, Ordering::Release);
    state.store(StreamState::Running as u8, Ordering::Release);
    if let Some(sender) = started_tx.take() {
        let _ = sender.send(Ok(()));
    }

    let channels = config.channels as usize;
    let capacity_samples = telemetry.queue_capacity_frames as usize * channels;
    let target_queue_frames = (endpoint.buffer_frames as usize * 2)
        .min(telemetry.queue_capacity_frames as usize / 2)
        .max(endpoint.buffer_frames as usize);
    let deadband_frames = (endpoint.buffer_frames as usize / 4).max(32);
    let mut queue = VecDeque::<f32>::with_capacity(capacity_samples);
    let mut render = vec![0.0_f32; endpoint.buffer_frames as usize * channels];
    let mut input = vec![0.0_f32; (endpoint.buffer_frames as usize + 1) * channels];
    let mut received_audio = false;

    while !stop_requested.load(Ordering::Acquire) {
        while let Ok(packet) = receiver.try_recv() {
            let mut converted = convert_external_packet(packet, config);
            if converted.is_empty() {
                continue;
            }
            telemetry
                .input_peak_bits
                .store(peak_dbfs(&converted).to_bits(), Ordering::Relaxed);
            let process_result = catch_unwind(AssertUnwindSafe(|| {
                processor.process(&mut converted, config.channels);
            }));
            if process_result.is_err() {
                return Err(AudioError::ProcessorFailure(
                    "the browser-tab processor panicked; audio was stopped".into(),
                ));
            }
            let mut clipped = 0_u64;
            for sample in &mut converted {
                if !sample.is_finite() {
                    *sample = 0.0;
                } else if sample.abs() > 1.0 {
                    clipped += 1;
                }
            }
            telemetry
                .clipped_samples
                .fetch_add(clipped, Ordering::Relaxed);
            let incoming_frames = converted.len() / channels;
            telemetry
                .captured_frames
                .fetch_add(incoming_frames as u64, Ordering::Relaxed);
            if converted.len() > capacity_samples.saturating_sub(queue.len()) {
                let overflow = converted
                    .len()
                    .saturating_sub(capacity_samples.saturating_sub(queue.len()));
                let aligned = overflow.div_ceil(channels) * channels;
                for _ in 0..aligned.min(queue.len()) {
                    queue.pop_front();
                }
                telemetry
                    .dropped_frames
                    .fetch_add((aligned / channels) as u64, Ordering::Relaxed);
            }
            queue.extend(converted.into_iter().take(capacity_samples));
        }

        if endpoint.event.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
            continue;
        }
        let frames = endpoint
            .audio_client
            .get_available_space_in_frames()
            .map_err(|error| stream_error("read browser output capacity", error))?;
        if frames == 0 {
            continue;
        }
        let output_frames = frames as usize;
        let needed = output_frames * channels;
        if render.len() < needed {
            render.resize(needed, 0.0);
        }
        let queued_frames = queue.len() / channels;
        telemetry
            .queue_fill_frames
            .store(queued_frames as u32, Ordering::Relaxed);
        if !received_audio && queued_frames < target_queue_frames {
            render[..needed].fill(0.0);
        } else {
            received_audio = true;
            let desired_frames = if queued_frames > target_queue_frames + deadband_frames {
                telemetry.clock_adjustments.fetch_add(1, Ordering::Relaxed);
                output_frames + 1
            } else if queued_frames < target_queue_frames.saturating_sub(deadband_frames)
                && output_frames > 1
                && queued_frames >= output_frames - 1
            {
                telemetry.clock_adjustments.fetch_add(1, Ordering::Relaxed);
                output_frames - 1
            } else {
                output_frames
            };
            let desired_samples = desired_frames * channels;
            if input.len() < desired_samples {
                input.resize(desired_samples, 0.0);
            }
            let available_samples = desired_samples.min(queue.len());
            let available_samples = available_samples - available_samples % channels;
            for destination in &mut input[..available_samples] {
                *destination = queue.pop_front().unwrap_or(0.0);
            }
            let available_frames = available_samples / channels;
            if available_frames < desired_frames {
                telemetry.underrun_frames.fetch_add(
                    (desired_frames - available_frames) as u64,
                    Ordering::Relaxed,
                );
            }
            if available_frames == desired_frames {
                resample_interleaved_linear(
                    &input[..available_samples],
                    available_frames,
                    &mut render[..needed],
                    output_frames,
                    channels,
                );
            } else {
                render[..needed].fill(0.0);
                let copied = available_frames.min(output_frames) * channels;
                render[..copied].copy_from_slice(&input[..copied]);
            }
        }
        endpoint
            .render_client
            .write_to_device(frames as usize, cast_slice(&render[..needed]), None)
            .map_err(|error| stream_error("render browser-tab audio", error))?;
        telemetry
            .rendered_frames
            .fetch_add(frames as u64, Ordering::Relaxed);
        telemetry
            .output_peak_bits
            .store(peak_dbfs(&render[..needed]).to_bits(), Ordering::Relaxed);
    }
    Ok(())
}

fn convert_external_packet(packet: ExternalPcmPacket, config: StreamConfig) -> Vec<f32> {
    let input_channels = packet.channels as usize;
    let input_frames = packet.samples.len() / input_channels;
    if input_frames == 0 {
        return Vec::new();
    }
    let mut stereo = Vec::with_capacity(input_frames * 2);
    for frame in packet.samples.chunks_exact(input_channels) {
        let left = if frame[0].is_finite() { frame[0] } else { 0.0 };
        let raw_right = if input_channels > 1 {
            frame[1]
        } else {
            frame[0]
        };
        let right = if raw_right.is_finite() {
            raw_right
        } else {
            0.0
        };
        stereo.push(left);
        stereo.push(right);
    }
    if packet.sample_rate_hz == config.sample_rate_hz {
        return stereo;
    }
    let output_frames = ((input_frames as u64 * config.sample_rate_hz as u64
        + packet.sample_rate_hz as u64 / 2)
        / packet.sample_rate_hz as u64)
        .max(1) as usize;
    let mut converted = vec![0.0_f32; output_frames * 2];
    resample_interleaved_linear(&stereo, input_frames, &mut converted, output_frames, 2);
    converted
}

struct RenderEndpoint {
    audio_client: AudioClient,
    render_client: AudioRenderClient,
    event: Handle,
    buffer_frames: u32,
}

impl RenderEndpoint {
    fn open(
        output_device_id: &str,
        config: StreamConfig,
        format: &WaveFormat,
    ) -> Result<Self, AudioError> {
        let enumerator =
            DeviceEnumerator::new().map_err(|error| stream_error("create enumerator", error))?;
        let device = enumerator
            .get_device(output_device_id)
            .map_err(|error| AudioError::DeviceNotFound(format!("output endpoint: {error}")))?;
        if device.get_direction() != Direction::Render {
            return Err(AudioError::UnsupportedConfiguration(
                "selected output endpoint is not a render device".into(),
            ));
        }
        let mut audio_client = device
            .get_iaudioclient()
            .map_err(|error| stream_error("open output endpoint", error))?;
        let buffer_duration_hns = buffer_duration_hns(&audio_client, config)?;
        audio_client
            .initialize_client(
                format,
                &Direction::Render,
                &StreamMode::EventsShared {
                    autoconvert: true,
                    buffer_duration_hns,
                },
            )
            .map_err(|error| stream_error("initialize output endpoint", error))?;
        let event = audio_client
            .set_get_eventhandle()
            .map_err(|error| stream_error("create output event", error))?;
        let buffer_frames = audio_client
            .get_buffer_size()
            .map_err(|error| stream_error("read output buffer size", error))?;
        let render_client = audio_client
            .get_audiorenderclient()
            .map_err(|error| stream_error("open render client", error))?;
        Ok(Self {
            audio_client,
            render_client,
            event,
            buffer_frames,
        })
    }

    fn start_with_silence(&self, channels: usize) -> Result<(), AudioError> {
        let available = self
            .audio_client
            .get_available_space_in_frames()
            .map_err(|error| stream_error("read initial output capacity", error))?;
        let silence = vec![0.0_f32; available as usize * channels];
        self.render_client
            .write_to_device(available as usize, cast_slice(&silence), None)
            .map_err(|error| stream_error("prime output buffer", error))?;
        self.audio_client
            .start_stream()
            .map_err(|error| stream_error("start output stream", error))
    }
}

struct RenderThreadTask {
    output_device_id: String,
    config: StreamConfig,
    format: WaveFormat,
    consumer: Consumer<f32>,
    stop_requested: Arc<AtomicBool>,
    capture_stopped: Arc<AtomicBool>,
    telemetry: Arc<SharedTelemetry>,
    ready_tx: mpsc::Sender<Result<u32, AudioError>>,
}

impl RenderThreadTask {
    fn run(self) -> Result<(), AudioError> {
        let Self {
            output_device_id,
            config,
            format,
            mut consumer,
            stop_requested,
            capture_stopped,
            telemetry,
            ready_tx,
        } = self;
        let mut ready_tx = Some(ready_tx);
        let result: Result<(), AudioError> = (|| {
            let _com = ComGuard::initialize()?;
            let endpoint = RenderEndpoint::open(&output_device_id, config, &format)?;
            endpoint.start_with_silence(config.channels as usize)?;
            let _stop_guard = StopGuard(&endpoint.audio_client);
            telemetry
                .render_buffer_frames
                .store(endpoint.buffer_frames, Ordering::Relaxed);
            if let Some(sender) = ready_tx.take() {
                let _ = sender.send(Ok(endpoint.buffer_frames));
            }

            let channels = config.channels as usize;
            let mut samples = vec![0.0_f32; endpoint.buffer_frames as usize * channels];
            let mut input_samples = vec![0.0_f32; (endpoint.buffer_frames as usize + 1) * channels];
            let queue_capacity_frames = telemetry.queue_capacity_frames as usize;
            let target_queue_frames = (endpoint.buffer_frames as usize * 2)
                .min(queue_capacity_frames.saturating_sub(1))
                .max(endpoint.buffer_frames as usize);
            let queue_deadband_frames = (endpoint.buffer_frames as usize / 4).max(32);
            let mut received_processed_audio = false;
            while !stop_requested.load(Ordering::Acquire)
                && !capture_stopped.load(Ordering::Acquire)
            {
                if endpoint.event.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
                    continue;
                }
                let frames = endpoint
                    .audio_client
                    .get_available_space_in_frames()
                    .map_err(|error| stream_error("read output capacity", error))?;
                if frames == 0 {
                    continue;
                }
                let needed = frames as usize * channels;
                if samples.len() < needed {
                    samples.resize(needed, 0.0);
                }
                let queued_frames = consumer.slots() / channels;
                telemetry
                    .queue_fill_frames
                    .store(queued_frames as u32, Ordering::Relaxed);

                if !received_processed_audio && queued_frames < target_queue_frames {
                    samples[..needed].fill(0.0);
                } else {
                    received_processed_audio = true;
                    let output_frames = frames as usize;
                    let desired_input_frames = if queued_frames
                        > target_queue_frames.saturating_add(queue_deadband_frames)
                        && queued_frames > output_frames
                    {
                        telemetry.clock_adjustments.fetch_add(1, Ordering::Relaxed);
                        output_frames + 1
                    } else if queued_frames
                        < target_queue_frames.saturating_sub(queue_deadband_frames)
                        && output_frames > 1
                        && queued_frames >= output_frames - 1
                    {
                        telemetry.clock_adjustments.fetch_add(1, Ordering::Relaxed);
                        output_frames - 1
                    } else {
                        output_frames
                    };
                    let desired_samples = desired_input_frames * channels;
                    if input_samples.len() < desired_samples {
                        input_samples.resize(desired_samples, 0.0);
                    }
                    let popped_samples = {
                        let (popped, _) =
                            consumer.pop_partial_slice(&mut input_samples[..desired_samples]);
                        popped.len()
                    };
                    let popped_frames = popped_samples / channels;
                    if popped_frames < desired_input_frames {
                        telemetry.underrun_frames.fetch_add(
                            (desired_input_frames - popped_frames) as u64,
                            Ordering::Relaxed,
                        );
                    }
                    if popped_frames == desired_input_frames {
                        resample_interleaved_linear(
                            &input_samples[..popped_frames * channels],
                            popped_frames,
                            &mut samples[..needed],
                            output_frames,
                            channels,
                        );
                    } else {
                        samples[..needed].fill(0.0);
                        let copied_samples = popped_frames.min(output_frames) * channels;
                        samples[..copied_samples].copy_from_slice(&input_samples[..copied_samples]);
                    }
                }
                endpoint
                    .render_client
                    .write_to_device(frames as usize, cast_slice(&samples[..needed]), None)
                    .map_err(|error| stream_error("render processed audio", error))?;
                telemetry
                    .rendered_frames
                    .fetch_add(frames as u64, Ordering::Relaxed);
                telemetry
                    .output_peak_bits
                    .store(peak_dbfs(&samples[..needed]).to_bits(), Ordering::Relaxed);
            }
            Ok(())
        })();

        capture_stopped.store(true, Ordering::Release);
        if let Err(error) = &result {
            if let Some(sender) = ready_tx.take() {
                let _ = sender.send(Err(error.clone()));
            }
        }
        result
    }
}

struct StopGuard<'a>(&'a AudioClient);

impl Drop for StopGuard<'_> {
    fn drop(&mut self) {
        let _ = self.0.stop_stream();
    }
}

fn buffer_duration_hns(client: &AudioClient, config: StreamConfig) -> Result<i64, AudioError> {
    let (default_period, minimum_period) = client
        .get_device_period()
        .map_err(|error| stream_error("read endpoint period", error))?;
    let desired = config
        .preferred_buffer_frames
        .map_or(default_period, |frames| {
            ((frames as u64 * 10_000_000_u64) / config.sample_rate_hz as u64) as i64
        });
    Ok(desired.max(minimum_period).min(50_000_000))
}

fn queue_capacity_frames(config: StreamConfig) -> usize {
    let target = config.preferred_buffer_frames.unwrap_or_else(|| {
        config
            .sample_rate_hz
            .saturating_mul(DEFAULT_TARGET_BUFFER_MS)
            / 1_000
    }) as usize;
    target
        .saturating_mul(8)
        .max(MIN_QUEUE_FRAMES)
        .next_power_of_two()
}

fn resample_interleaved_linear(
    input: &[f32],
    input_frames: usize,
    output: &mut [f32],
    output_frames: usize,
    channels: usize,
) {
    if input_frames == 0 || output_frames == 0 || channels == 0 {
        output.fill(0.0);
        return;
    }
    if input_frames == output_frames {
        output[..output_frames * channels].copy_from_slice(&input[..input_frames * channels]);
        return;
    }
    if input_frames == 1 || output_frames == 1 {
        for frame in output[..output_frames * channels].chunks_exact_mut(channels) {
            frame.copy_from_slice(&input[..channels]);
        }
        return;
    }

    let scale = (input_frames - 1) as f64 / (output_frames - 1) as f64;
    for output_index in 0..output_frames {
        let position = output_index as f64 * scale;
        let lower = position.floor() as usize;
        let upper = (lower + 1).min(input_frames - 1);
        let fraction = (position - lower as f64) as f32;
        for channel in 0..channels {
            let a = input[lower * channels + channel];
            let b = input[upper * channels + channel];
            output[output_index * channels + channel] = a + (b - a) * fraction;
        }
    }
}

fn peak_dbfs(samples: &[f32]) -> f32 {
    let peak = samples
        .iter()
        .filter_map(|sample| sample.is_finite().then_some(sample.abs()))
        .fold(0.0_f32, f32::max);
    if peak <= f32::MIN_POSITIVE {
        -120.0
    } else {
        (20.0 * peak.log10()).clamp(-120.0, 24.0)
    }
}

fn decode_state(value: u8) -> StreamState {
    match value {
        value if value == StreamState::Starting as u8 => StreamState::Starting,
        value if value == StreamState::Running as u8 => StreamState::Running,
        value if value == StreamState::Stopping as u8 => StreamState::Stopping,
        value if value == StreamState::Stopped as u8 => StreamState::Stopped,
        value if value == StreamState::Failed as u8 => StreamState::Failed,
        _ => StreamState::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_frame_aligned_and_has_room_for_jitter() {
        let config = StreamConfig {
            preferred_buffer_frames: Some(128),
            ..StreamConfig::default()
        };
        assert_eq!(queue_capacity_frames(config), 2_048);
    }

    #[test]
    fn transport_inference_is_conservative() {
        assert_eq!(infer_transport("USB DAC"), DeviceTransport::Usb);
        assert_eq!(
            infer_transport("CABLE Input (VB-Audio Virtual Cable)"),
            DeviceTransport::Virtual
        );
        assert_eq!(infer_transport("Mystery DAC"), DeviceTransport::Unknown);
    }

    #[test]
    fn peak_meter_handles_silence_and_non_finite_values() {
        assert_eq!(peak_dbfs(&[0.0, f32::NAN]), -120.0);
        assert!((peak_dbfs(&[0.5]) + 6.0206).abs() < 0.001);
    }

    #[test]
    fn drift_resampler_preserves_endpoints_and_channel_alignment() {
        let input = [0.0, 10.0, 1.0, 11.0, 2.0, 12.0];
        let mut output = [0.0; 8];
        resample_interleaved_linear(&input, 3, &mut output, 4, 2);
        assert_eq!(&output[..2], &[0.0, 10.0]);
        assert_eq!(&output[6..], &[2.0, 12.0]);
        assert!((output[2] - 2.0 / 3.0).abs() < 1.0e-6);
        assert!((output[3] - 10.0 - 2.0 / 3.0).abs() < 1.0e-6);
    }

    #[test]
    fn drift_resampler_turns_empty_input_into_silence() {
        let mut output = [1.0; 6];
        resample_interleaved_linear(&[], 0, &mut output, 3, 2);
        assert_eq!(output, [0.0; 6]);
    }

    #[test]
    fn external_mono_pcm_is_duplicated_to_stereo() {
        let packet = ExternalPcmPacket {
            samples: vec![0.25, -0.5],
            sample_rate_hz: 48_000,
            channels: 1,
        };
        let converted = convert_external_packet(packet, StreamConfig::default());
        assert_eq!(converted, vec![0.25, 0.25, -0.5, -0.5]);
    }

    #[test]
    fn external_pcm_is_resampled_to_the_dac_rate() {
        let packet = ExternalPcmPacket {
            samples: vec![0.0; 480 * 2],
            sample_rate_hz: 48_000,
            channels: 2,
        };
        let config = StreamConfig {
            sample_rate_hz: 44_100,
            ..StreamConfig::default()
        };
        let converted = convert_external_packet(packet, config);
        assert_eq!(converted.len(), 441 * 2);
    }
}
