# UZjam 0.6 — Chrome tab audio for Windows

Development build. Known functional and distribution gaps remain; see the [29 October 2026 audit](docs/UZJAM_AUDIT_2026-10-29.md) before using this as a release candidate. The repository includes source and build instructions; generated installers, local dependencies, and signing credentials are excluded.

UZjam 0.6 adds a Chrome companion extension that lets you select one exact browser tab and send its audio directly to the Windows app—no virtual cable and no screen-sharing picker. The desktop bridge feeds the selected tab into the same Rust DSP, headroom, limiter, telemetry, and WASAPI DAC output used by the native product. The established UI, canonical `UzjamProfile`, and portable Rust DSP remain shared.

## Windows quick start

```powershell
npm ci
npm run desktop:dev
```

In the Windows app, open **Settings → Windows audio**, select the everyday playback device under **Direct output**, and enable direct EQ. The capture-to-output WASAPI route remains available as a compatibility path for live inputs or devices without a signed UZjam endpoint package.

### Use one Chrome tab without a virtual cable

1. Build the extension with `npm run build:extension`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `target\extension\uzjam-tab-audio-0.6.0`.
3. Open the UZjam desktop app, confirm your DAC under **Settings → Windows audio → Listening output**, then choose **Source → Browser tab**.
4. Copy the 10-character pairing code shown in UZjam.
5. Click the UZjam extension in Chrome, paste the code once, and select the exact tab you want to hear.

The tab's dry Chrome playback is suppressed while capture is active. UZjam is the only playback path and sends the processed signal to the selected DAC. The WebSocket bridge listens only on `127.0.0.1`, accepts Chrome-extension origins, and requires the per-install pairing code.

For local compatibility testing with a TOPPING DAC and VB-Cable, prepare a clean physical output first:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\configure-windows-clean-audio.ps1 -EndpointName "TOPPING USB DAC"
```

This disables other endpoint effects only on the selected DAC, turns off Boom's startup task, closes Boom, and reports the DAC's Spatial Audio state. It leaves unrelated audio devices alone and supports `-Restore` when switching to the signed direct-APO path.

See [WINDOWS_BUILD.md](WINDOWS_BUILD.md) for prerequisites, full verification, release packaging, and troubleshooting.

## What is implemented

- A versioned, portable `UzjamProfile` for filters, channels, user preamp, headroom, clipping policy, targets and device bindings.
- An adapter from the current V2 editing model into that profile, including migration of previously saved browser state.
- A strict `BrowserUzjamEngineClient` fallback that validates owned profile copies and is authoritative for:
  - RBJ biquad response;
  - independent left and right cascades;
  - combined-curve peak scanning;
  - automatic or manual headroom;
  - positive-boost smoothing;
  - effective filter gains and effective preamp.
- The existing graph, safety panel and signal-path readouts consume engine analysis rather than calculating EQ or headroom in the frontend.
- Web Audio consumes the engine's effective filter gains and linear preamp value for local files and an explicitly shared browser tab.
- Canonical `.uzjam.json` export. Legacy and canonical JSON can both be imported into the current editor.
- Validated canonical preset file helpers plus recoverable, versioned local settings snapshots.
- Rust `uzjam-core`, `uzjam-dsp` and `uzjam-audio` crates that mirror the portable model, DSP semantics and platform boundary.
- A Tauri v2 Windows host for native device enumeration, source/output selection, route lifecycle, bypass, latency targets, and runtime error/telemetry reporting.
- A Windows 11 endpoint-effect APO with COM activation, Settings Framework property storage, live profile notifications, fixed graph latency, and a non-allocating real-time handoff into the shared Rust DSP.
- Desktop controls that discover whether the endpoint component is associated with the selected output and publish profile changes directly to its per-user property store.
- A stereo-linked, 5 ms look-ahead output limiter with a 4× interpolated peak detector and a profile-defined ceiling.
- Adaptive queue control that absorbs capture/render clock drift with click-resistant, block-wide interpolation and reports every correction.
- Exact-route recovery after device resets, with bounded backoff and no silent substitution of microphones, speakers, or DACs.
- A repeatable Windows release driver that runs all quality gates and collects checksummed artifacts.

The user preamp and the protection budget are deliberately separate. For example, a `+1 dB` preamp remains user intent; automatic headroom is additional engine-selected attenuation, and manual headroom does not overwrite the preamp.

## Channel semantics

- `stereo`: the filter is applied to both left and right processing chains.
- `left`: the filter is applied only to the left chain.
- `right`: the filter is applied only to the right chain.
- The graph's `stereo` view is the arithmetic mean, in dB, of the independently calculated left and right responses. It is a visual composite, not a replacement for channel processing.

## Repository map

```text
apps/web/                         Existing V2 UI and Web Audio host
extensions/chrome/                Exact-tab Chrome capture and loopback-only PCM bridge
src-tauri/                        Thin Windows desktop bridge and Tauri packaging
packages/uzjam-contract/          Canonical TypeScript contract + V2 adapters
packages/uzjam-engine-client/     Browser engine client, validation and DSP analysis
crates/uzjam-core/                Rust profile model and validation
crates/uzjam-dsp/                 Rust response/headroom/PCM processing
crates/uzjam-audio/               Platform-neutral audio backend interface
crates/uzjam-apo-ffi/             Stable C ABI and real-time APO/DSP bridge
windows/apo/                      Thin Windows endpoint APO, smoke test and INF sources
schema/                           JSON Schema for portable profiles
examples/                         Canonical profile example
tools/                            Conformance and boundary checks
```

## Verification

```bash
npm ci
npm test
npm run build
npm run validate:schema
cargo test --workspace --all-targets
```

`npm test` includes 16 engine/adapter/preset tests, 10 persistence and recovery tests, DSP reference checks, and a frontend-boundary check that rejects reintroduced response/headroom helpers in the V2 application.

See [P0_INTEGRATION_REPORT.md](P0_INTEGRATION_REPORT.md) for the exact validation record and remaining blockers.

## Current boundary

The direct audio engine is implemented and locally testable, but Windows distribution has one external release gate.

- Windows requires modern APOs to ship as a signed componentized driver package and to be associated by a device-specific audio-driver extension. The checked-in component INF and extension template are ready for that workflow, but a single unsigned universal INF cannot safely attach a new APO to every third-party audio driver.
- Until a signed package is installed for the selected endpoint, the app reports **Direct component required** and keeps the explicit WASAPI compatibility route available.
- Direct processing targets shared-mode endpoint playback. Exclusive/offload paths can bypass system effects, and the EQ remains stereo-first; additional channels receive latency-aligned pass-through.
- Chrome 116 or newer is required for extension tab capture. Chrome internal pages and protected/DRM media may reject capture.
- The optional look-ahead limiter adds 5 ms of DSP latency. Its 4× interpolated detector is a practical safety stage, not a standards-certified ITU/EBU true-peak meter.
- The current V2 editor exposes peak, low-shelf and high-shelf filters. The canonical engine contract also supports pass, notch, band-pass and all-pass filters; those require future editor controls for lossless round-tripping through this UI.
- The optimized Windows executable and NSIS installer build successfully on this checkout; release machines still need the MSVC toolchain and Windows SDK.
- AAudio/Oboe, CoreAudio, PipeWire, and iOS adapters remain future work; the shared profile and DSP crates do not import WASAPI.

The response display reports transfer gain. Actual dBFS is shown only from live Web Audio metering because output peak cannot be inferred from an EQ curve alone.
