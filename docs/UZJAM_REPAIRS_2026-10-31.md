# Windows usability repairs — 31 October 2026

Reviewed GitHub `main` at `ae4fedf90a6bfe9a18cc27a0da837f4e3ad802b6` against the 29 October audit. No newer branch or PR was available at the start of this review. The 0.6.0 build records describe earlier Windows artifacts; they do not validate this repaired source.

## Changes

| Audit finding | Repair | Evidence |
| --- | --- | --- |
| 1: stale faders/preamp | Refresh canonical engine analysis before updating the response, headroom and playback parameters; persist that updated profile. | DOM integration test exercises real fader events, Web Audio parameter calls through a fake graph, persistence and reopening. |
| 2: files cannot reconnect after restart | Reselection reconnects the existing library identity and queue tracks instead of rejecting the file as a duplicate. Repeated selection does not duplicate queue entries. | Import → persisted restart → same-file reselection integration test. |
| 4: malformed backup breaks startup | Validate embedded active/saved canonical profiles before storage writes, backup restoration and native restoration. Reject invalid recovery slots and continue to a valid backup. | Invalid schema 999 and nested saved-profile tests; rejection preserves the good primary. |
| 5: protection misses out-of-display frequencies | Separate the audible-band response grid from the headroom scan. Both TypeScript and Rust now scan through the complete digital band, include DC/Nyquist and filter centres. | Shelf regressions at 44.1, 48 and 96 kHz, including probes below 20 Hz and above 20 kHz. This remains sampled static transfer analysis, not true-peak certification. |
| 7: reconnect restores old EQ | Update the stored recovery request only after the new processor has been accepted. Retain exact source/output IDs. | Rust host test with a mock stream; rejected updates retain the last accepted profile. |
| 26: Cancel/Close saves profiles | Make cancel controls non-submit buttons and explicitly close the dialog. | DOM tests cover empty/filled names, both cancel controls and a successful save. |

## Local verification

- `npm test`: 17 contract/engine tests, 19 web/persistence/DOM tests and 10 extension behavior/source checks passed, plus DSP reference and frontend ownership checks.
- `npm run build` and `npm run validate:schema` passed.
- `cargo test --locked -p uzjam-core -p uzjam-dsp -p uzjam-audio -p uzjam-apo-ffi`: 27 tests passed on Linux.
- The actual audio_host.rs and extension_bridge.rs were compiled through a temporary standalone Linux harness; five recovery/handshake regressions passed. This excludes the Windows-only backend and the Tauri shell.
- Clippy with warnings denied passed for the four portable crates and their test targets.
- DOM integration uses jsdom and fake media/Web Audio objects. It does not decode audio or establish audible correctness. A Chromium launch was unavailable in this execution environment.

The new Windows validation workflow runs the full Rust workspace/tests, clippy and Tauri installer build, then retains the unsigned test installer as an Actions artifact. Its presence is not evidence of a successful run. Check the run results for the exact commit before claiming Windows build success.

## Remaining release work

The original audit still applies except where this report explicitly records a repair or mitigation. Browser playback still lacks a transient limiter; Chrome-to-DAC resampling and live capture validation remain release work; native visualizers and solo need alignment with the DSP route; switching Direct endpoints can leave the previous endpoint enabled. The system-wide Direct APO package is still non-installable and requires signing/device association.

No Windows installation, real DAC playback, extension installation, reset/reconnect hardware test, multihour soak or new signed release was performed here. Do not use the old October 9 release metadata as evidence for this source revision.

Android remains a planned platform adapter. Keep the canonical profile, portable DSP and platform audio boundary shared; validate a dependable Windows route before expanding to Android.

## Additional preset and capture repairs

- **Canonical presets (finding 3):** import uses canonical validation instead of the lossy legacy parser. All eight filter kinds, channel/enabled state, filter order, unclamped finite values, independent safety margin/limiter settings, bypass, target/device binding and source metadata survive import and reopening. Neutral missing editor controls do not become extra canonical filters. Empty/tone-only imports clear the previous tuning. Unsupported schema versions and profiles that cannot run on the current analysis route are rejected before mutation. Undo/redo includes profile identity and bypass.
- **Bank layout (finding 23):** newly saved UI profiles retain the selected bank count alongside the portable canonical object. Standalone canonical files infer a suitable bank rather than claiming to contain a UI layout field.
- **Web Audio consistency (finding 19):** playback no longer silently moves 20 kHz to 19.845 kHz at 44.1 kHz. Low/high-pass Q is converted from the profile's linear value to Web Audio's decibel convention. The new filter controls expose pass/notch/band-pass/all-pass types.
- **Chrome grants (finding 10):** the picker offers the currently invoked tab and the service worker verifies its identity before requesting capture. Open the extension on a different tab to select that tab. `activeTab` replaces unrestricted tab metadata access.
- **Extension installation declaration (finding 39):** localhost host permission uses Chrome's documented HTTP match pattern, replacing the unsupported WebSocket match-pattern scheme. This is a source correction; a real Chrome installation is still required for compatibility sign-off.
- **Cancellation (finding 11 plus extension races):** desktop startup checks cancellation after device refresh; the extension checks ownership after asynchronous permission, worklet and context operations. Stop closes provisional resources, old socket events cannot stop a newer capture, and service-worker offscreen-document creation is serialized.
- **Transport backlog (finding 17):** a WebSocket queue beyond 200 ms of stereo float PCM stops capture and asks for a fresh connection instead of retaining unbounded stale audio.
- **Native handshake/shutdown (finding 8):** HTTP handshakes and hello messages have deadlines and nonblocking polling; shutdown is checked during handshake/read loops. Frame/message limits apply before PCM parsing. In-memory Rust handshake tests exercise origin/path validation, size configuration, timeout and shutdown.
- **Limiter disclosure (finding 6, mitigation only):** the UI explicitly says that the look-ahead limiter applies to native routes and browser playback has no transient limiter. A browser limiter has not been implemented.

New tests execute the actual preset UI import/reload/undo flow and Web Audio parameter mapping, plus extension service-worker/offscreen scripts against controlled browser/media/socket fakes. These are behavioral regressions rather than live Chrome capture or DAC tests. Check the latest Windows workflow result before using this additional source as a Windows test build.

The Windows job now also packages the Chrome companion and creates SHA256SUMS.txt files for both the installer and companion ZIP. The companion still requires Chrome Developer mode and Load unpacked.
