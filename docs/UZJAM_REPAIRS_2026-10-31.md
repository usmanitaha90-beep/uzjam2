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

- `npm test`: 17 contract/engine tests, 15 web/persistence/DOM tests and 3 extension source checks passed, plus DSP reference and frontend ownership checks.
- `npm run build` and `npm run validate:schema` passed.
- `cargo test --locked -p uzjam-core -p uzjam-dsp -p uzjam-audio -p uzjam-apo-ffi`: 27 tests passed on Linux.
- The actual `src-tauri/src/audio_host.rs` was compiled through a temporary standalone Linux harness; the new mock-stream recovery regression passed. This excludes the Windows-only backend and the Tauri shell.
- Clippy with warnings denied passed for the four portable crates and their test targets.
- DOM integration uses jsdom and fake media/Web Audio objects. It does not decode audio or establish audible correctness. A Chromium launch was unavailable in this execution environment.

The new Windows validation workflow runs the full Rust workspace/tests, clippy and Tauri installer build, then retains the unsigned test installer as an Actions artifact. Its presence is not evidence of a successful run. Check the run results for the exact commit before claiming Windows build success.

## Remaining release work

The original audit still applies to findings not listed above. In particular: canonical preset import can still coerce unsupported filters/values; browser playback does not implement the advertised limiter; Chrome capture permissions, bridge handshakes, transport backpressure and resampling need repair; native visualizers and solo need alignment with the DSP route. The system-wide Direct APO package is still non-installable and requires signing/device association.

No Windows installation, real DAC playback, extension installation, reset/reconnect hardware test, multihour soak or new signed release was performed here. Do not use the old October 9 release metadata as evidence for this source revision.

Android remains a planned platform adapter. Keep the canonical profile, portable DSP and platform audio boundary shared; validate a dependable Windows route before expanding to Android.
