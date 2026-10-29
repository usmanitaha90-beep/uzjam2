# UZjam 0.4 Windows hardening report

## Outcome

UZjam now builds as a Windows desktop application with a real WASAPI capture-to-render route and the shared Rust DSP inserted between the selected endpoints. The existing high-fidelity V2 interface remains the product surface; a thin Tauri bridge owns native device, lifecycle, persistence, and telemetry commands.

This is a usable explicit-route Windows MVP. It is not yet a driver-level same-endpoint system equalizer.

## Delivered scope

| Area | Result |
| --- | --- |
| Portable audio boundary | `uzjam-audio` exposes source/output enumeration, routes, negotiated config, lifecycle, telemetry, and asynchronous failures without importing DSP behavior |
| Windows adapter | Event-driven shared-mode WASAPI capture/loopback → bounded SPSC buffer → render implementation isolated in `crates/uzjam-audio/src/windows.rs` |
| DSP insertion | Canonical `UzjamProfile` builds the Rust stereo processor; live edits use a short crossfade, or a fade-through-silence transition when limiter latency changes |
| Device UX | Native source/output selectors, explicit start/stop, refresh, buffer targets, format/latency/xrun readouts, and actionable errors |
| Safety | Auto/Curve/Smooth/Allow-clipping policies remain engine-owned; optional stereo-linked 5 ms look-ahead limiting; non-finite samples are silenced; same loopback/output endpoints are rejected |
| Clock stability | Queue prefill plus single-frame, block-wide interpolation keeps unrelated capture/render clocks centered and exposes correction telemetry |
| Reconnect | Optional launch and device-reset recovery use only the exact last-working endpoint IDs, with five bounded retries and no fallback substitution |
| Presets | Canonical `.uzjam.json` validation, import/export, portable filenames, and profile save/load |
| Persistence | Versioned staged writes with pending and last-known-good recovery; full settings backup export/restore; native app-data mirror |
| Lifecycle | Native stream stop and endpoint release on explicit stop, window close, exit request, and frontend shutdown preparation |
| Packaging | Tauri v2 desktop target, branded icons, optimized executable, NSIS installer, and checksummed release driver |
| Portability | `uzjam-core` and `uzjam-dsp` remain platform-agnostic; all WASAPI dependencies are Windows-target-gated |

## Windows audio shape

```text
Windows capture endpoint or render-loopback source
        ↓  event-driven shared-mode capture
bounded frame-aligned SPSC queue
        ↓
portable Rust StereoEqProcessor
        ↓  auto/manual headroom + active profile
distinct Windows render endpoint
```

The distinct-output requirement is deliberate. Ordinary WASAPI loopback does not mute the original endpoint. Sending processed loopback audio back to that same endpoint would double the signal or feed it back. A future virtual endpoint or APO is required for transparent same-device system interception.

## Validation record

Validated on Windows on October 7, 2026:

| Check | Status |
| --- | --- |
| TypeScript, engine, adapter, preset tests | Passed — 16/16 |
| Web persistence/recovery tests | Passed — 10/10 |
| DSP reference + frontend boundary checks | Passed |
| JSON Schema validation | Passed |
| Rust workspace tests | Passed — 25/25 plus desktop/example targets |
| Rust clippy with warnings denied | Passed |
| Rust formatting | Passed |
| Desktop debug compilation | Passed |
| WASAPI live endpoint smoke route | Passed |
| Optimized Tauri application | Built successfully |
| NSIS installer | Built successfully — `UZjam_0.4.0_x64-setup.exe` |
| Packaged app runtime/accessibility check | Passed — window startup, real device enumeration, v0.4 controls/safety guidance, exact-process clean close; pixel capture was unavailable because the desktop was locked |

## Current limitations

1. **No transparent same-endpoint system interception.** Use a virtual cable/loopback source and a different physical DAC/output. A production virtual endpoint or APO is future work.
2. **Shared mode only.** Exclusive-mode applications may bypass the route; the adapter intentionally does not claim exclusive output support.
3. **Stereo-first.** The product route currently requests two-channel floating-point PCM. Multichannel mapping is not included.
4. **Clock correction is pragmatic.** The adaptive path distributes a one-frame correction across a render block. It is intentionally small and click-resistant, but is not a mastering-grade asynchronous sample-rate converter and still needs multi-hour hardware soak coverage.
5. **Recovery never guesses.** Device resets recover the exact route when possible. A removed, renamed, or replaced endpoint requires the user to choose again.
6. **Limiter certification.** The limiter uses look-ahead and 4× interpolated detection with a hard output ceiling. It is not yet certified against an ITU/EBU true-peak conformance suite.
7. **Unsigned installer.** The local NSIS artifact is valid but unsigned and may trigger SmartScreen until release signing is configured.
8. **Other platforms are not wired yet.** Android, macOS, Linux, and iOS retain the shared contracts and DSP but still need their platform adapters and shells.

## Next production step

The highest-value next step is a signed virtual-audio-endpoint/APO so users can choose UZjam as the Windows playback device and hear only the processed physical output. Code signing, multi-hour hardware soak tests, and standards-based true-peak conformance measurement remain release gates for broad distribution.
