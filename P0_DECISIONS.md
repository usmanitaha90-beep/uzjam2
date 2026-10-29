# UZjam P0 architectural decisions

## ADR-001 — One engine contract, portable Rust target

**Status:** Accepted

Authoritative EQ, response and headroom behavior lives behind `UzjamEngineClient`. P0 ships a browser implementation for the working V2 product and a Rust implementation for the native target. View code must not become a third implementation.

**Why:** Windows, Android, macOS, Linux, iOS and the browser fallback must converge on the same tuning semantics while native integration is built incrementally.

## ADR-002 — Profiles are versioned product contracts

**Status:** Accepted

Every portable profile uses `UzjamProfile` with an explicit `schemaVersion`. JSON uses camelCase, and TypeScript, Rust and JSON Schema definitions represent the same product concepts.

**Why:** A profile must remain intelligible across platforms without translation logic scattered through UI components.

## ADR-003 — OS audio is an adapter, not the DSP engine

**Status:** Accepted

`uzjam-audio` defines devices, streams and runtime capabilities. WASAPI/APO, AAudio/Oboe, CoreAudio/AVAudioEngine and PipeWire implementations will sit behind that boundary.

**Why:** Platform restrictions differ. UZjam should degrade by capability without forking filter behavior.

## ADR-004 — Basic and Advanced edit one profile

**Status:** Accepted

Basic tone controls and Advanced parametric controls adapt into the same canonical filter collection. There are not separate EQ engines.

**Why:** This prevents semantic drift and keeps profile import/export predictable.

## ADR-005 — Preamp and headroom are independent

**Status:** Accepted

`preampDb` is user-authored gain. `manualHeadroomDb` is a positive protection budget. The engine derives `appliedHeadroomDb` and `effectivePreampDb` without overwriting either input.

**Why:** A user-selected preamp is creative intent; protection is a separate safety decision. Conflating them makes presets ambiguous and breaks manual control.

## ADR-006 — Protection policy is explicit

**Status:** Accepted

Headroom and clipping state is represented by Auto / Manual / Off and Auto / Smooth / Curve / Allow Clipping. Auto preserves the curve and selects attenuation; Curve applies the manual budget; Smooth may reduce only positive boosts; Off/Allow Clipping applies no protective attenuation.

**Why:** UZjam should warn accurately and preserve user authority without hidden processing.

## ADR-007 — Response is channel-correct

**Status:** Accepted

`stereo` filters feed both cascades; `left` and `right` filters feed only their respective cascade. Engine analysis returns both channels. The stereo graph is explicitly the arithmetic mean of left/right magnitude in dB.

**Why:** Channel routing must affect playback and safety analysis, while the composite graph needs a stable, documented meaning.

## ADR-008 — Transfer gain is not dBFS

**Status:** Accepted

UZjam distinguishes EQ transfer gain, protection attenuation and measured signal peak. A filter-only result is never labelled as output dBFS.

**Why:** Actual dBFS depends on input samples. Audiophile-grade telemetry must survive measurement and scrutiny.

## ADR-009 — The browser client is a real fallback, not UI math

**Status:** Accepted

Until a native bridge is available, `BrowserUzjamEngineClient` owns validation, response and protection decisions. The V2 app receives effective filter and preamp parameters and only constructs the Web Audio graph.

**Why:** This enforces the final dependency direction now and makes the native client replaceable behind one interface.

## ADR-010 — Browser playback is source-scoped

**Status:** Accepted

The fallback processes local files or a browser tab explicitly shared by the user. It does not represent itself as system-wide processing.

**Why:** Browser security boundaries are product facts, not implementation details.

## ADR-011 — Canonical export is the interchange format

**Status:** Accepted

Profile export writes a validated `UzjamProfile`. Import remains tolerant of legacy V2 JSON so users are not stranded during migration.

**Why:** New files should stop perpetuating the legacy model while old work remains recoverable.

## ADR-012 — Realtime processing avoids allocation

**Status:** Accepted

Rust filter state is prepared outside the per-frame loop; PCM processing mutates preallocated state.

**Why:** Predictable latency and glitch resistance matter across desktop and mobile.

## ADR-013 — Reserved fields do not imply implemented processing

**Status:** Superseded by ADR-016

`limiterEnabled` was originally reserved in the portable contract without an active limiter.

**Why:** The schema can reserve stable product intent without making a false signal-path claim.

## ADR-014 — Windows MVP uses an explicit source and distinct output

**Status:** Accepted

The first native route uses event-driven shared-mode WASAPI capture or render-loopback, processes stereo PCM through the portable Rust engine, and renders to a separately selected endpoint. A system-loopback source may not target its own underlying render endpoint.

**Why:** WASAPI loopback observes but does not silence the original endpoint. Same-endpoint render would double or feed back the signal. Transparent system-wide correction requires a future virtual endpoint or APO and must not be implied by the MVP.

## ADR-015 — Automatic reconnect never substitutes devices

**Status:** Accepted

Launch and device-reset reconnect are attempted only for the exact persisted endpoint identifiers. Missing devices produce an actionable stopped state; the UI may show defaults for manual selection but does not start them automatically.

**Why:** Silently replacing a disconnected virtual source or DAC with a microphone or speakers can create feedback and violates user control over routing.

## ADR-016 — Limiting and endpoint-clock control stay platform-neutral

**Status:** Accepted

`limiterEnabled` inserts a stereo-linked 5 ms look-ahead limiter in `uzjam-dsp`. The Windows adapter controls queue fill by resampling one fewer or one extra input frame across a render block when the queue leaves its deadband.

**Why:** Output safety belongs in the shared signal processor, while capture/render clock reconciliation belongs at the platform I/O boundary. Neither concern should leak WASAPI behavior into the portable profile model.
