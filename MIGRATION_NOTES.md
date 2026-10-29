# UZjam V2 → P0 migration notes

## Result

The current V2 experience is preserved, but its EQ editor is no longer authoritative for DSP-derived values. V2 state is adapted into `UzjamProfile`; `BrowserUzjamEngineClient` validates that profile and returns response, headroom and effective playback parameters.

```text
Before: V2 controls → frontend response/headroom helpers → graph + Web Audio

Now:    V2 controls → UzjamProfile → UzjamEngineClient
                                      ├─ graph + safety analysis
                                      └─ Web Audio parameters
```

The HTML structure, CSS and interaction model were retained. This pass is an architecture migration, not a visual redesign.

## State migration

- Existing local browser state still loads through the V2 storage migration.
- When `uzjamProfile` is present, its canonical filter and DSP values hydrate the current controls.
- When it is absent, `migrateCurrentV2State()` creates schema version 1 from the active V2 editor state.
- Basic tone filters and Advanced filters share one canonical `filters` collection. Their IDs preserve which controls hydrate each editor.
- `both`, `L` and `R` are normalized to `stereo`, `left` and `right`.
- `auto`, manual curve, smooth and allow-clipping choices are mapped to explicit `headroomMode` and `clippingPolicy` values.
- The canonical profile is persisted alongside V2-only view, library, history and playback state.

The V2 band arrays remain as the interaction adapter for the existing controls. They no longer contain response, cascade-peak or protection algorithms.

## Analysis migration

The following frontend-owned decisions were removed from `apps/web/src/app.js`:

- biquad coefficient and magnitude calculations;
- response-series generation;
- maximum combined-curve gain scanning;
- automatic headroom selection;
- smoothing-factor selection;
- effective filter-gain derivation.

The application now consumes `EngineAnalysis`:

- `requestedResponse` draws the user's requested curve;
- `effectiveResponse` draws the protected/smoothed curve;
- `headroom` supplies transfer peak, required/applied attenuation, effective preamp, remaining margin and predicted overage;
- `effectiveFilters` configures Web Audio filter nodes;
- `effectivePreampLinear` configures the Web Audio pre-gain node.

Frequency-to-screen coordinates, UI clamping, animation and live meter calculations remain frontend concerns. They are presentation or measured-signal work, not authoritative filter analysis.

## Preamp correction

V2 previously risked conflating user preamp with protection. P0 stores these independently:

- `preampDb`: the gain explicitly chosen by the user;
- `manualHeadroomDb`: a positive attenuation budget for manual/smooth policies;
- `appliedHeadroomDb`: the engine's result for the active policy;
- `effectivePreampDb = preampDb - appliedHeadroomDb`.

Automatic headroom evaluates the actual left and right filter cascades plus user preamp and safety margin. Overlapping `+6 dB` and `+3 dB` filters can therefore require approximately `9 dB` of curve headroom rather than being treated as a single `6 dB` boost.

## Import and export

- Profile export now writes the engine-owned schema version 1 `UzjamProfile` directly as `.uzjam.json`.
- The importer accepts canonical profiles and older V2-style JSON, then normalizes them for the current editor.
- The current V2 editor exposes peak, low-shelf and high-shelf controls. Other canonical filter kinds are engine-valid but need future UI support before this editor can round-trip them without normalization.

## Compatibility notes

- Bypass and Solo are transient analysis/audition inputs and do not rewrite the stored profile.
- Left/right filters are analyzed and processed independently. The stereo graph is their dB-average display.
- The browser implementation reports browser capabilities honestly and does not claim system-wide EQ.
- Live dBFS meters remain signal-derived. Static EQ analysis reports transfer gain and predicted overage, not an invented output level.

## Native migration status

- The Windows Tauri host now sends the canonical profile into the shared Rust processor and WASAPI adapter.
- `limiterEnabled` now activates the shared stereo-linked look-ahead limiter; the existing −1 dB safety switch controls both its ceiling and the static safety reserve.
- Windows capture/render clock drift is corrected at the adapter boundary, and the exact route can recover after endpoint resets.
- Remaining migration work is explicit editor support for every canonical filter kind, shared browser/Rust golden vectors, and additional platform adapters based on runtime capabilities.
