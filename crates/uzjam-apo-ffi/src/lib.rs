//! Stable C ABI between the Windows endpoint APO and UZjam's portable Rust DSP.
//!
//! Profiles are prepared on a non-real-time thread. `uzjam_apo_process_f32`
//! only touches preallocated processors and atomics: it performs no allocation,
//! locking, file I/O, logging, or system calls.

use std::cell::UnsafeCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicI8, AtomicU32, AtomicUsize, Ordering};
use uzjam_core::{
    ChannelMode, ClippingPolicy, DspSettings, EqFilter, FilterKind, HeadroomMode, ProfileMetadata,
    UzjamProfile, ValidationSeverity, PROFILE_SCHEMA_VERSION,
};
use uzjam_dsp::StereoEqProcessor;

pub const UZJAM_APO_ABI_VERSION: u32 = 1;
pub const UZJAM_APO_MAX_FILTERS: usize = 64;

pub const UZJAM_APO_OK: i32 = 0;
pub const UZJAM_APO_ERROR_NULL: i32 = 1;
pub const UZJAM_APO_ERROR_ABI: i32 = 2;
pub const UZJAM_APO_ERROR_VALUE: i32 = 3;
pub const UZJAM_APO_ERROR_FILTER_COUNT: i32 = 4;
pub const UZJAM_APO_ERROR_DSP: i32 = 5;
pub const UZJAM_APO_ERROR_BUSY: i32 = 6;
pub const UZJAM_APO_ERROR_PANIC: i32 = 7;
pub const UZJAM_APO_ERROR_CHANNELS: i32 = 8;

const PENDING_IDLE: i8 = -1;
const PENDING_TRANSITION: i8 = -2;
const PENDING_WRITING: i8 = -3;
const CROSSFADE_FRAMES: u32 = 128;
const FIXED_LATENCY_MS: f64 = 5.0;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct UzjamApoFilterConfig {
    pub enabled: u32,
    pub kind: u32,
    pub channel: u32,
    pub reserved: u32,
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q: f64,
}

impl Default for UzjamApoFilterConfig {
    fn default() -> Self {
        Self {
            enabled: 0,
            kind: 0,
            channel: 0,
            reserved: 0,
            frequency_hz: 1_000.0,
            gain_db: 0.0,
            q: 1.0,
        }
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct UzjamApoProfileConfig {
    pub size: u32,
    pub abi_version: u32,
    pub filter_count: u32,
    pub enabled: u32,
    pub preamp_db: f64,
    pub manual_headroom_db: f64,
    pub safety_margin_db: f64,
    pub headroom_mode: u32,
    pub clipping_policy: u32,
    pub limiter_enabled: u32,
    pub reserved: u32,
    pub filters: [UzjamApoFilterConfig; UZJAM_APO_MAX_FILTERS],
}

impl Default for UzjamApoProfileConfig {
    fn default() -> Self {
        Self {
            size: std::mem::size_of::<Self>() as u32,
            abi_version: UZJAM_APO_ABI_VERSION,
            filter_count: 0,
            enabled: 1,
            preamp_db: 0.0,
            manual_headroom_db: 0.0,
            safety_margin_db: 0.3,
            headroom_mode: 0,
            clipping_policy: 0,
            limiter_enabled: 0,
            reserved: 0,
            filters: [UzjamApoFilterConfig::default(); UZJAM_APO_MAX_FILTERS],
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Transition {
    active: bool,
    from: usize,
    to: usize,
    position: u32,
    warmup: u32,
    length: u32,
    latency_change: bool,
}

impl Default for Transition {
    fn default() -> Self {
        Self {
            active: false,
            from: 0,
            to: 0,
            position: 0,
            warmup: 0,
            length: CROSSFADE_FRAMES,
            latency_change: false,
        }
    }
}

#[derive(Debug)]
struct FixedLatencyProcessor {
    dsp: StereoEqProcessor,
    compensation: Vec<[f32; 2]>,
    write_index: usize,
}

impl FixedLatencyProcessor {
    fn new(
        profile: &UzjamProfile,
        sample_rate_hz: f64,
        fixed_latency_frames: u32,
    ) -> Result<Self, i32> {
        let dsp = StereoEqProcessor::from_profile(profile, sample_rate_hz)
            .map_err(|_| UZJAM_APO_ERROR_DSP)?;
        let dsp_latency = u32::try_from(dsp.latency_frames()).map_err(|_| UZJAM_APO_ERROR_VALUE)?;
        if dsp_latency > fixed_latency_frames {
            return Err(UZJAM_APO_ERROR_DSP);
        }
        let compensation_frames = (fixed_latency_frames - dsp_latency) as usize;
        Ok(Self {
            dsp,
            compensation: vec![[0.0, 0.0]; compensation_frames],
            write_index: 0,
        })
    }

    fn process_stereo_frame(&mut self, left: f32, right: f32) -> (f32, f32) {
        let processed = self.dsp.process_stereo_frame(left, right);
        if self.compensation.is_empty() {
            return processed;
        }
        let delayed = self.compensation[self.write_index];
        self.compensation[self.write_index] = [processed.0, processed.1];
        self.write_index = (self.write_index + 1) % self.compensation.len();
        (delayed[0], delayed[1])
    }
}

#[derive(Debug)]
struct ExtraChannelDelay {
    samples: Vec<f32>,
    write_frame: usize,
    channels: usize,
    latency_frames: usize,
}

impl ExtraChannelDelay {
    fn new(channels: u32, latency_frames: u32) -> Self {
        let channels = channels.saturating_sub(2) as usize;
        let latency_frames = latency_frames as usize;
        Self {
            samples: vec![0.0; channels.saturating_mul(latency_frames)],
            write_frame: 0,
            channels,
            latency_frames,
        }
    }

    fn process_frame(&mut self, input: *const f32, output: *mut f32, base: usize) {
        if self.channels == 0 {
            return;
        }
        let delay_base = self.write_frame * self.channels;
        for channel in 0..self.channels {
            // SAFETY: the handle's validated channel count guarantees these
            // samples are inside the caller-provided frame.
            let sample = finite_sample(unsafe { ptr::read(input.add(base + channel + 2)) });
            let delayed = self.samples[delay_base + channel];
            self.samples[delay_base + channel] = sample;
            unsafe { ptr::write(output.add(base + channel + 2), delayed) };
        }
        self.write_frame = (self.write_frame + 1) % self.latency_frames.max(1);
    }
}

/// Opaque to C. One control thread may stage profiles while exactly one audio
/// thread calls `uzjam_apo_process_f32`.
pub struct UzjamApoHandle {
    processors: [UnsafeCell<FixedLatencyProcessor>; 2],
    latencies: [AtomicU32; 2],
    active: AtomicUsize,
    pending: AtomicI8,
    transition: UnsafeCell<Transition>,
    extra_channel_delay: UnsafeCell<ExtraChannelDelay>,
    sample_rate_hz: f64,
    channels: u32,
}

// Synchronization is deliberately internal: the control thread only writes an
// inactive slot after claiming PENDING_WRITING, and the single RT thread owns
// all processor mutation plus `transition`.
unsafe impl Send for UzjamApoHandle {}
unsafe impl Sync for UzjamApoHandle {}

impl UzjamApoHandle {
    fn new(
        sample_rate_hz: f64,
        channels: u32,
        config: &UzjamApoProfileConfig,
    ) -> Result<Self, i32> {
        validate_stream(sample_rate_hz, channels)?;
        let profile = profile_from_config(config)?;
        let latency = (sample_rate_hz * FIXED_LATENCY_MS / 1_000.0).round() as u32;
        let first = FixedLatencyProcessor::new(&profile, sample_rate_hz, latency)?;
        let second = FixedLatencyProcessor::new(&profile, sample_rate_hz, latency)?;

        Ok(Self {
            processors: [UnsafeCell::new(first), UnsafeCell::new(second)],
            latencies: [AtomicU32::new(latency), AtomicU32::new(latency)],
            active: AtomicUsize::new(0),
            pending: AtomicI8::new(PENDING_IDLE),
            transition: UnsafeCell::new(Transition::default()),
            extra_channel_delay: UnsafeCell::new(ExtraChannelDelay::new(channels, latency)),
            sample_rate_hz,
            channels,
        })
    }

    fn stage(&self, config: &UzjamApoProfileConfig) -> Result<(), i32> {
        let profile = profile_from_config(config)?;
        let latency = self.latencies[self.active.load(Ordering::Acquire)].load(Ordering::Relaxed);
        let processor = FixedLatencyProcessor::new(&profile, self.sample_rate_hz, latency)?;

        self.pending
            .compare_exchange(
                PENDING_IDLE,
                PENDING_WRITING,
                Ordering::Acquire,
                Ordering::Relaxed,
            )
            .map_err(|_| UZJAM_APO_ERROR_BUSY)?;

        let inactive = 1 - self.active.load(Ordering::Acquire);
        // SAFETY: PENDING_WRITING excludes the audio thread from adopting this
        // slot. IDLE guarantees no prior transition still reads it.
        unsafe {
            *self.processors[inactive].get() = processor;
        }
        self.latencies[inactive].store(latency, Ordering::Relaxed);
        self.pending.store(inactive as i8, Ordering::Release);
        Ok(())
    }

    fn latency_frames(&self) -> u32 {
        let active = self.active.load(Ordering::Acquire);
        self.latencies[active].load(Ordering::Relaxed)
    }

    fn process(&self, input: *const f32, output: *mut f32, frames: u32, channels: u32) {
        self.begin_pending_transition();

        for frame in 0..frames as usize {
            let base = frame * channels as usize;
            // SAFETY: the caller guarantees readable/writable buffers for the
            // validated frame count. Exact in-place input/output is supported.
            let left = finite_sample(unsafe { ptr::read(input.add(base)) });
            let right = if channels > 1 {
                finite_sample(unsafe { ptr::read(input.add(base + 1)) })
            } else {
                left
            };

            let (processed_left, processed_right) = self.process_stereo(left, right);
            unsafe {
                ptr::write(output.add(base), processed_left);
                if channels > 1 {
                    ptr::write(output.add(base + 1), processed_right);
                }
            }
            // SAFETY: only the documented RT caller mutates this fixed delay.
            unsafe { &mut *self.extra_channel_delay.get() }.process_frame(input, output, base);
        }
    }

    fn begin_pending_transition(&self) {
        // SAFETY: only the one documented RT caller accesses transition.
        let transition = unsafe { &mut *self.transition.get() };
        if transition.active {
            return;
        }

        let pending = self.pending.load(Ordering::Acquire);
        if pending < 0
            || self
                .pending
                .compare_exchange(
                    pending,
                    PENDING_TRANSITION,
                    Ordering::Acquire,
                    Ordering::Relaxed,
                )
                .is_err()
        {
            return;
        }

        let from = self.active.load(Ordering::Relaxed);
        let to = pending as usize;
        *transition = Transition {
            active: true,
            from,
            to,
            position: 0,
            warmup: self.latencies[to].load(Ordering::Relaxed),
            length: CROSSFADE_FRAMES,
            latency_change: self.latencies[from].load(Ordering::Relaxed)
                != self.latencies[to].load(Ordering::Relaxed),
        };
    }

    fn process_stereo(&self, left: f32, right: f32) -> (f32, f32) {
        // SAFETY: only the one documented RT caller accesses transition and
        // mutates processors. A control writer can only touch the inactive slot
        // before the transition is published.
        let transition = unsafe { &mut *self.transition.get() };
        if !transition.active {
            let active = self.active.load(Ordering::Relaxed);
            return unsafe {
                (&mut *self.processors[active].get()).process_stereo_frame(left, right)
            };
        }

        let old = unsafe {
            (&mut *self.processors[transition.from].get()).process_stereo_frame(left, right)
        };
        let new = unsafe {
            (&mut *self.processors[transition.to].get()).process_stereo_frame(left, right)
        };

        if transition.position < transition.warmup {
            transition.position += 1;
            return old;
        }

        let fade = transition.length.max(1);
        let fade_position = transition.position - transition.warmup;
        let (old_gain, new_gain) = if transition.latency_change {
            if fade_position < fade {
                (1.0 - (fade_position + 1) as f32 / fade as f32, 0.0)
            } else {
                (0.0, (fade_position - fade + 1) as f32 / fade as f32)
            }
        } else {
            let new_gain = (fade_position + 1) as f32 / fade as f32;
            (1.0 - new_gain, new_gain)
        };

        let mixed = (
            old.0 * old_gain + new.0 * new_gain,
            old.1 * old_gain + new.1 * new_gain,
        );
        transition.position += 1;

        let total = if transition.latency_change {
            transition.warmup + fade * 2
        } else {
            transition.warmup + fade
        };
        if transition.position >= total {
            let new_active = transition.to;
            transition.active = false;
            self.active.store(new_active, Ordering::Release);
            self.pending.store(PENDING_IDLE, Ordering::Release);
        }
        mixed
    }
}

fn finite_sample(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn validate_stream(sample_rate_hz: f64, channels: u32) -> Result<(), i32> {
    if !sample_rate_hz.is_finite() || !(40.0..=384_000.0).contains(&sample_rate_hz) {
        return Err(UZJAM_APO_ERROR_VALUE);
    }
    if channels == 0 || channels > 4096 {
        return Err(UZJAM_APO_ERROR_CHANNELS);
    }
    Ok(())
}

fn profile_from_config(config: &UzjamApoProfileConfig) -> Result<UzjamProfile, i32> {
    if config.size as usize != std::mem::size_of::<UzjamApoProfileConfig>()
        || config.abi_version != UZJAM_APO_ABI_VERSION
    {
        return Err(UZJAM_APO_ERROR_ABI);
    }
    let count = config.filter_count as usize;
    if count > UZJAM_APO_MAX_FILTERS {
        return Err(UZJAM_APO_ERROR_FILTER_COUNT);
    }

    let headroom_mode = match config.headroom_mode {
        0 => HeadroomMode::Auto,
        1 => HeadroomMode::Manual,
        2 => HeadroomMode::Off,
        _ => return Err(UZJAM_APO_ERROR_VALUE),
    };
    let clipping_policy = match config.clipping_policy {
        0 => ClippingPolicy::Auto,
        1 => ClippingPolicy::Smooth,
        2 => ClippingPolicy::Curve,
        3 => ClippingPolicy::AllowClipping,
        _ => return Err(UZJAM_APO_ERROR_VALUE),
    };

    let mut filters = Vec::with_capacity(count);
    for (index, filter) in config.filters[..count].iter().enumerate() {
        let kind = match filter.kind {
            0 => FilterKind::Peak,
            1 => FilterKind::LowShelf,
            2 => FilterKind::HighShelf,
            3 => FilterKind::LowPass,
            4 => FilterKind::HighPass,
            5 => FilterKind::Notch,
            6 => FilterKind::BandPass,
            7 => FilterKind::AllPass,
            _ => return Err(UZJAM_APO_ERROR_VALUE),
        };
        let channel = match filter.channel {
            0 => ChannelMode::Stereo,
            1 => ChannelMode::Left,
            2 => ChannelMode::Right,
            _ => return Err(UZJAM_APO_ERROR_VALUE),
        };
        filters.push(EqFilter {
            id: format!("apo-{index}"),
            enabled: filter.enabled != 0,
            kind,
            frequency_hz: filter.frequency_hz,
            gain_db: filter.gain_db,
            q: filter.q,
            channel,
        });
    }

    let profile = UzjamProfile {
        schema_version: PROFILE_SCHEMA_VERSION,
        id: "windows-endpoint".into(),
        name: "Windows endpoint".into(),
        filters,
        dsp: DspSettings {
            enabled: config.enabled != 0,
            preamp_db: config.preamp_db,
            manual_headroom_db: config.manual_headroom_db,
            headroom_mode,
            safety_margin_db: config.safety_margin_db,
            clipping_policy,
            limiter_enabled: config.limiter_enabled != 0,
        },
        target: None,
        device_binding: None,
        metadata: ProfileMetadata {
            created_at_utc: "endpoint".into(),
            modified_at_utc: "endpoint".into(),
            source: Some("windows-apo".into()),
        },
    };

    if profile
        .validate()
        .iter()
        .any(|issue| issue.severity == ValidationSeverity::Error)
    {
        return Err(UZJAM_APO_ERROR_VALUE);
    }
    Ok(profile)
}

/// Encodes the portable profile into the fixed-size settings blob shared with
/// the Windows 11 audio effects property store.
pub fn config_from_profile(profile: &UzjamProfile) -> Result<UzjamApoProfileConfig, i32> {
    if profile.filters.len() > UZJAM_APO_MAX_FILTERS {
        return Err(UZJAM_APO_ERROR_FILTER_COUNT);
    }
    if profile
        .validate()
        .iter()
        .any(|issue| issue.severity == ValidationSeverity::Error)
    {
        return Err(UZJAM_APO_ERROR_VALUE);
    }

    let mut config = UzjamApoProfileConfig {
        filter_count: profile.filters.len() as u32,
        enabled: u32::from(profile.dsp.enabled),
        preamp_db: profile.dsp.preamp_db,
        manual_headroom_db: profile.dsp.manual_headroom_db,
        safety_margin_db: profile.dsp.safety_margin_db,
        headroom_mode: match profile.dsp.headroom_mode {
            HeadroomMode::Auto => 0,
            HeadroomMode::Manual => 1,
            HeadroomMode::Off => 2,
        },
        clipping_policy: match profile.dsp.clipping_policy {
            ClippingPolicy::Auto => 0,
            ClippingPolicy::Smooth => 1,
            ClippingPolicy::Curve => 2,
            ClippingPolicy::AllowClipping => 3,
        },
        limiter_enabled: u32::from(profile.dsp.limiter_enabled),
        ..UzjamApoProfileConfig::default()
    };
    for (index, filter) in profile.filters.iter().enumerate() {
        config.filters[index] = UzjamApoFilterConfig {
            enabled: u32::from(filter.enabled),
            kind: match filter.kind {
                FilterKind::Peak => 0,
                FilterKind::LowShelf => 1,
                FilterKind::HighShelf => 2,
                FilterKind::LowPass => 3,
                FilterKind::HighPass => 4,
                FilterKind::Notch => 5,
                FilterKind::BandPass => 6,
                FilterKind::AllPass => 7,
            },
            channel: match filter.channel {
                ChannelMode::Stereo => 0,
                ChannelMode::Left => 1,
                ChannelMode::Right => 2,
            },
            reserved: 0,
            frequency_hz: filter.frequency_hz,
            gain_db: filter.gain_db,
            q: filter.q,
        };
    }
    // Keep encoding and decoding validation symmetric, including enum values.
    profile_from_config(&config)?;
    Ok(config)
}

#[no_mangle]
pub extern "C" fn uzjam_apo_abi_version() -> u32 {
    UZJAM_APO_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn uzjam_apo_profile_config_size() -> u32 {
    std::mem::size_of::<UzjamApoProfileConfig>() as u32
}

/// Creates an engine. The caller owns the returned handle and must destroy it
/// after audio processing has stopped.
///
/// # Safety
///
/// `config` must point to a readable configuration and `out_handle` must point
/// to writable storage for one handle. Both pointers must remain valid for the
/// duration of this call.
#[no_mangle]
pub unsafe extern "C" fn uzjam_apo_create(
    sample_rate_hz: f64,
    channels: u32,
    config: *const UzjamApoProfileConfig,
    out_handle: *mut *mut UzjamApoHandle,
) -> i32 {
    if config.is_null() || out_handle.is_null() {
        return UZJAM_APO_ERROR_NULL;
    }
    ptr::write(out_handle, ptr::null_mut());
    match catch_unwind(AssertUnwindSafe(|| {
        let handle = UzjamApoHandle::new(sample_rate_hz, channels, &*config)?;
        ptr::write(out_handle, Box::into_raw(Box::new(handle)));
        Ok::<(), i32>(())
    })) {
        Ok(Ok(())) => UZJAM_APO_OK,
        Ok(Err(code)) => code,
        Err(_) => UZJAM_APO_ERROR_PANIC,
    }
}

/// Stages a fully prepared profile on the caller's non-real-time thread.
///
/// # Safety
///
/// `handle` must be a live handle returned by `uzjam_apo_create`, and `config`
/// must point to a readable configuration for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn uzjam_apo_stage_profile(
    handle: *mut UzjamApoHandle,
    config: *const UzjamApoProfileConfig,
) -> i32 {
    if handle.is_null() || config.is_null() {
        return UZJAM_APO_ERROR_NULL;
    }
    match catch_unwind(AssertUnwindSafe(|| (&*handle).stage(&*config))) {
        Ok(Ok(())) => UZJAM_APO_OK,
        Ok(Err(code)) => code,
        Err(_) => UZJAM_APO_ERROR_PANIC,
    }
}

/// Processes float32 interleaved frames. Exact in-place buffers are supported.
/// The first stereo pair is EQ'd; additional channels are passed through.
///
/// # Safety
///
/// `handle` must be live. `input` and `output` must each reference at least
/// `frame_count * channels` contiguous samples. They may be identical but must
/// not partially overlap. No other thread may process with the same handle.
#[no_mangle]
pub unsafe extern "C" fn uzjam_apo_process_f32(
    handle: *mut UzjamApoHandle,
    input: *const f32,
    output: *mut f32,
    frame_count: u32,
    channels: u32,
) -> i32 {
    if handle.is_null() || input.is_null() || output.is_null() {
        return UZJAM_APO_ERROR_NULL;
    }
    let handle_ref = &*handle;
    if channels != handle_ref.channels || channels == 0 {
        return UZJAM_APO_ERROR_CHANNELS;
    }
    if (frame_count as usize)
        .checked_mul(channels as usize)
        .is_none()
    {
        return UZJAM_APO_ERROR_VALUE;
    }

    match catch_unwind(AssertUnwindSafe(|| {
        handle_ref.process(input, output, frame_count, channels)
    })) {
        Ok(()) => UZJAM_APO_OK,
        Err(_) => UZJAM_APO_ERROR_PANIC,
    }
}

#[no_mangle]
/// Returns the fixed processing latency for a live engine handle.
///
/// # Safety
///
/// `handle` must be null or a live handle returned by `uzjam_apo_create`.
pub unsafe extern "C" fn uzjam_apo_latency_frames(handle: *const UzjamApoHandle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    catch_unwind(AssertUnwindSafe(|| (&*handle).latency_frames())).unwrap_or_default()
}

/// Must not race with `uzjam_apo_process_f32` or `uzjam_apo_stage_profile`.
///
/// # Safety
///
/// `handle` must be null or a live handle returned by `uzjam_apo_create`, and
/// it must not have been destroyed previously.
#[no_mangle]
pub unsafe extern "C" fn uzjam_apo_destroy(handle: *mut UzjamApoHandle) {
    if handle.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(handle))));
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn create(config: &UzjamApoProfileConfig) -> *mut UzjamApoHandle {
        let mut handle = ptr::null_mut();
        assert_eq!(
            uzjam_apo_create(48_000.0, 2, config, &mut handle),
            UZJAM_APO_OK
        );
        assert!(!handle.is_null());
        handle
    }

    #[test]
    fn abi_layout_is_stable() {
        assert_eq!(std::mem::size_of::<UzjamApoFilterConfig>(), 40);
        assert_eq!(std::mem::size_of::<UzjamApoProfileConfig>(), 2_616);
        assert_eq!(uzjam_apo_profile_config_size(), 2_616);
    }

    #[test]
    fn flat_profile_passes_stereo_and_extra_channels() {
        let config = UzjamApoProfileConfig {
            headroom_mode: 2,
            ..Default::default()
        };
        let handle = unsafe { create(&config) };
        let input = [0.25, -0.5, 0.75, 0.125];
        let mut output = [0.0; 4];
        assert_eq!(
            unsafe { uzjam_apo_process_f32(handle, input.as_ptr(), output.as_mut_ptr(), 1, 4) },
            UZJAM_APO_ERROR_CHANNELS
        );
        assert_eq!(
            unsafe { uzjam_apo_process_f32(handle, input.as_ptr(), output.as_mut_ptr(), 2, 2) },
            UZJAM_APO_OK
        );
        assert_eq!(output, [0.0; 4]);
        unsafe { uzjam_apo_destroy(handle) };

        let mut four_channel = ptr::null_mut();
        assert_eq!(
            unsafe { uzjam_apo_create(48_000.0, 4, &config, &mut four_channel) },
            UZJAM_APO_OK
        );
        let mut multichannel_output = [0.0; 4];
        assert_eq!(
            unsafe {
                uzjam_apo_process_f32(
                    four_channel,
                    input.as_ptr(),
                    multichannel_output.as_mut_ptr(),
                    1,
                    4,
                )
            },
            UZJAM_APO_OK
        );
        assert_eq!(multichannel_output, [0.0; 4]);
        unsafe { uzjam_apo_destroy(four_channel) };
    }

    #[test]
    fn exact_in_place_processing_is_supported() {
        let config = UzjamApoProfileConfig {
            headroom_mode: 2,
            ..Default::default()
        };
        let handle = unsafe { create(&config) };
        let mut samples = [0.25, -0.5, 0.75, -0.125];
        assert_eq!(
            unsafe { uzjam_apo_process_f32(handle, samples.as_ptr(), samples.as_mut_ptr(), 2, 2,) },
            UZJAM_APO_OK
        );
        assert_eq!(samples, [0.0; 4]);
        unsafe { uzjam_apo_destroy(handle) };
    }

    #[test]
    fn limiter_reports_latency_and_holds_the_ceiling() {
        let config = UzjamApoProfileConfig {
            headroom_mode: 2,
            clipping_policy: 3,
            preamp_db: 12.0,
            safety_margin_db: 1.0,
            limiter_enabled: 1,
            ..Default::default()
        };
        let handle = unsafe { create(&config) };
        assert_eq!(unsafe { uzjam_apo_latency_frames(handle) }, 240);

        let input = vec![0.9_f32; 4_000];
        let mut output = vec![0.0_f32; input.len()];
        assert_eq!(
            unsafe { uzjam_apo_process_f32(handle, input.as_ptr(), output.as_mut_ptr(), 2_000, 2) },
            UZJAM_APO_OK
        );
        let ceiling = 10.0_f32.powf(-1.0 / 20.0);
        assert!(output.iter().all(|sample| sample.abs() <= ceiling + 1.0e-6));
        assert!(output.iter().any(|sample| sample.abs() > ceiling * 0.9));
        unsafe { uzjam_apo_destroy(handle) };
    }

    #[test]
    fn profile_update_crossfades_without_a_step() {
        let initial = UzjamApoProfileConfig {
            headroom_mode: 2,
            ..Default::default()
        };
        let handle = unsafe { create(&initial) };

        let mut updated = initial;
        updated.preamp_db = -12.0;
        assert_eq!(
            unsafe { uzjam_apo_stage_profile(handle, &updated) },
            UZJAM_APO_OK
        );

        let input = vec![0.5_f32; 1_024];
        let mut output = vec![0.0_f32; 1_024];
        assert_eq!(
            unsafe { uzjam_apo_process_f32(handle, input.as_ptr(), output.as_mut_ptr(), 512, 2,) },
            UZJAM_APO_OK
        );
        for pair in output[480..].windows(2) {
            assert!((pair[1] - pair[0]).abs() < 0.01);
        }
        assert!((output[900] - 0.5 * 10.0_f32.powf(-12.0 / 20.0)).abs() < 1.0e-5);
        unsafe { uzjam_apo_destroy(handle) };
    }

    #[test]
    fn limiter_toggle_keeps_fixed_endpoint_latency() {
        let initial = UzjamApoProfileConfig {
            headroom_mode: 2,
            ..Default::default()
        };
        let handle = unsafe { create(&initial) };
        assert_eq!(unsafe { uzjam_apo_latency_frames(handle) }, 240);

        let mut limited = initial;
        limited.limiter_enabled = 1;
        assert_eq!(
            unsafe { uzjam_apo_stage_profile(handle, &limited) },
            UZJAM_APO_OK
        );
        let input = vec![0.25_f32; 1_024];
        let mut output = vec![0.0_f32; 1_024];
        assert_eq!(
            unsafe { uzjam_apo_process_f32(handle, input.as_ptr(), output.as_mut_ptr(), 512, 2,) },
            UZJAM_APO_OK
        );
        assert!(output[500].abs() > 0.2);
        assert_eq!(unsafe { uzjam_apo_latency_frames(handle) }, 240);
        unsafe { uzjam_apo_destroy(handle) };
    }

    #[test]
    fn invalid_inputs_fail_closed() {
        let mut config = UzjamApoProfileConfig::default();
        config.abi_version += 1;
        let mut handle = ptr::null_mut();
        assert_eq!(
            unsafe { uzjam_apo_create(48_000.0, 2, &config, &mut handle) },
            UZJAM_APO_ERROR_ABI
        );
        assert!(handle.is_null());
        assert_eq!(
            unsafe { uzjam_apo_stage_profile(ptr::null_mut(), &config) },
            UZJAM_APO_ERROR_NULL
        );
        assert_eq!(
            unsafe { uzjam_apo_process_f32(ptr::null_mut(), ptr::null(), ptr::null_mut(), 0, 2,) },
            UZJAM_APO_ERROR_NULL
        );
    }

    #[test]
    fn portable_profile_round_trips_through_the_settings_blob() {
        let mut profile = profile_from_config(&UzjamApoProfileConfig::default()).unwrap();
        profile.dsp.preamp_db = -2.5;
        profile.filters.push(EqFilter {
            id: "presence".into(),
            enabled: true,
            kind: FilterKind::HighShelf,
            frequency_hz: 4_500.0,
            gain_db: 1.25,
            q: 0.7,
            channel: ChannelMode::Right,
        });
        let encoded = config_from_profile(&profile).unwrap();
        let decoded = profile_from_config(&encoded).unwrap();
        assert_eq!(decoded.dsp, profile.dsp);
        assert_eq!(decoded.filters.len(), 1);
        assert_eq!(decoded.filters[0].kind, FilterKind::HighShelf);
        assert_eq!(decoded.filters[0].channel, ChannelMode::Right);
        assert_eq!(decoded.filters[0].gain_db, 1.25);
    }
}
