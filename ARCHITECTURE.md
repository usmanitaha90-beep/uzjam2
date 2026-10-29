# UZjam P0 architecture

## Runtime shape

```text
Existing V2 UI
  ├─ view/interaction state: selection, history, navigation, queue, meters
  └─ EQ editor state
          │
          ▼
  current-V2 adapter
          │
          ▼
  canonical UzjamProfile
          │
          ▼
  UzjamEngineClient
          │
          ├─ requested/effective L/R/stereo response
          ├─ headroom analysis
          └─ effective filter gains + effective preamp
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   V2 graph/telemetry    Web Audio graph
                         local file or chosen tab
```

The browser analysis client remains the latency-free graph authority. In the desktop build, the same canonical profile also crosses the Tauri command boundary into the Rust runtime processor; view code never owns a second headroom algorithm.

```text
canonical UzjamProfile
        │
        ▼
Tauri command boundary
   ┌────┴────────────────┐
   ▼                     ▼
uzjam-core           uzjam-audio
profile/validation   backend + stream boundary
   │                     │
   ▼                     ├─ Windows: WASAPI (implemented)
uzjam-dsp                 ├─ Android: AAudio/Oboe (planned)
response/headroom/PCM     ├─ macOS/iOS: CoreAudio (planned)
                         └─ Linux: PipeWire (planned)
```

The Windows adapter is isolated behind `AudioBackend`; the remaining platform branches are architectural targets, not implemented claims.

## Ownership

| Layer | Owns | Does not own |
| --- | --- | --- |
| V2 UI | editing gestures, presentation, transient solo/bypass, library and playback UX | filter-response or headroom algorithms |
| `@uzjam/contract` | serializable profile and engine request/result types, V2 adapters | runtime DSP |
| `@uzjam/engine-client` | validation, response analysis, protection decisions, effective playback parameters | OS-wide routing |
| `uzjam-core` | durable Rust product state and validation | audio I/O |
| `uzjam-dsp` | Rust biquads, response/headroom semantics, PCM processing and look-ahead limiting | devices, permissions or UI |
| `uzjam-audio` | backend traits, stream/device types and capability vocabulary | filter behavior |
| platform adapters | device enumeration, permissions, routing and realtime stream policy | product-state semantics |
| Tauri host | command validation, persisted app data, stream ownership, clean shutdown | filter math or platform audio implementation |

## State flow

1. Existing V2 state is hydrated from browser storage.
2. A saved canonical profile is preferred when present; otherwise the V2 adapter creates one.
3. An edit is adapted into a complete `UzjamProfile` and validated by the engine client.
4. The client returns immutable analysis for the active sample rate, channel routing, bypass and audition state.
5. The graph and safety UI render that analysis.
6. Web Audio receives the returned effective gains and effective preamp for browser sources; it does not choose protection values itself.
7. When the Windows route is running, the canonical profile also prepares a Rust `StereoEqProcessor`; live replacements crossfade over 12 ms, while changes in limiter latency use a fade-through-silence transition to avoid comb filtering.
8. WASAPI owns capture/render timing, queue prefill, small clock-drift corrections and real stream telemetry without importing filter behavior.
9. Persistence retains staged primary, pending, and last-known-good snapshots in browser storage and native app data. Profile export emits the canonical object.

The V2 arrays remain an editing compatibility representation during P0. They are not an independent DSP authority.

## Response and channel definition

Each enabled filter contributes to the left cascade when its channel is `stereo` or `left`, and to the right cascade when its channel is `stereo` or `right`.

- `requestedResponse`: filter-only response using the user's requested gains.
- `effectiveResponse`: filter-only response after any positive-gain smoothing.
- `stereo`: `(left dB + right dB) / 2` at every frequency, used only as a composite display.
- User preamp and headroom attenuation are reported separately in `HeadroomAnalysis`; they are not baked into the response arrays.

Playback uses independent left/right chains in both Web Audio and Rust, so channel-specific filters are not averaged in the signal path.

## Headroom definition

The engine scans the real cascaded response for both channels. In simplified form:

```text
maximumEqGainDb     = max(0, peak(left), peak(right))
requestedCurvePeak = max(0, maximumEqGainDb + userPreampDb)
requiredHeadroom    = max(0, requestedCurvePeak + safetyMarginDb)
effectivePreampDb   = userPreampDb - appliedHeadroomDb
```

- `auto`: applies `requiredHeadroom` and preserves the requested filter curve.
- `manual` / `curve`: applies the explicit manual attenuation and preserves filter gains.
- `smooth`: applies the manual attenuation and scales only positive filter gains until the protected target is met; cuts remain unchanged.
- `off` or `allowClipping`: applies no protection.

`predictedOverDb` describes static transfer risk after the selected policy. It is not an actual output peak. Live dBFS requires input samples and is measured separately by the Web Audio meters.

## P0 invariants

1. The UI edits a profile and renders engine output; it does not implement authoritative DSP math.
2. The DSP engine is independent of platform audio routing.
3. Profiles are versioned, portable and exported canonically.
4. Basic and Advanced are editors of the same profile contract.
5. Preamp is user intent; headroom is a distinct protection value.
6. Left, right and stereo semantics are explicit and deterministic.
7. Capability support is reported at runtime rather than inferred from an app fork.
8. Aggressive finite values are valid; impossible or non-finite values are rejected.
9. No protection behavior is silently implied.
10. Transfer gain is never labelled as measured dBFS.
11. Automatic recovery retries only the exact last-working endpoint identifiers and never substitutes a device.
