# UZjam audit — 29 October 2026

Audited local source and packaged Windows UZjam 0.6.0, commit `589a87f68bdfbd92b868f6fb8aba89fd59872171`, plus the hosted Site publication. This register contains 40 findings: confirmed defects, unmet requirements, release/scope gaps, and two explicitly unverified compatibility risks. It is not a claim that every possible defect has been found.

No application source, driver, system setting, or hosted deployment was changed. Temporary local preview navigation was restored and the preview was closed.

## Findings

### 1. Faders do not immediately apply EQ

**P1.** Traditional band and preamp faders mutate editor state but never refresh the cached engine analysis. The number moves while audio, response and headroom stay stale until a separate engine-refresh action. Saving can write the old canonical profile and discard edits on reload.

Evidence: [apps/web/src/app.js:1385](../apps/web/src/app.js#L1385); [apps/web/src/app.js:2855](../apps/web/src/app.js#L2855).

### 2. Local files cannot reconnect normally after restart

**P1.** Queue file access is cleared on startup. Selecting the same file again is rejected as a duplicate before its File object is restored, leaving it unplayable unless its library record is removed first.

Evidence: [apps/web/src/app.js:281](../apps/web/src/app.js#L281); [apps/web/src/app.js:2158](../apps/web/src/app.js#L2158); [apps/web/src/app.js:2629](../apps/web/src/app.js#L2629).

### 3. Canonical preset import silently changes the preset

**P1.** Pass/notch/band-pass/all-pass filters become peaking filters; gains and preamp are capped; imported bypass and target/device metadata are not preserved. Reproduced with a disabled low-pass profile.

Evidence: [apps/web/src/app.js:2727](../apps/web/src/app.js#L2727); [apps/web/src/app.js:347](../apps/web/src/app.js#L347).

### 4. An accepted backup can prevent app startup

**P1.** Backup validation checks outer containers but not the embedded canonical profile. A schemaVersion 999 profile can be accepted and saved, then throws while constructing the engine before initialization.

Evidence: [apps/web/src/persistence.js:108](../apps/web/src/persistence.js#L108); [apps/web/src/app.js:383](../apps/web/src/app.js#L383).

### 5. Automatic headroom misses out-of-display frequencies

**P1.** The safety scan covers 20 Hz–20 kHz rather than the complete digital bandwidth. A permitted +18 dB shelf at 20 kHz/48 kHz leaves +8.70 dB net transfer gain at 23.9 kHz despite Auto protection; low-frequency boundaries have a corresponding omission.

Evidence: [packages/uzjam-engine-client/src/dsp.ts:186](../packages/uzjam-engine-client/src/dsp.ts#L186); [packages/uzjam-engine-client/src/dsp.ts:259](../packages/uzjam-engine-client/src/dsp.ts#L259); [crates/uzjam-dsp/src/lib.rs:843](../crates/uzjam-dsp/src/lib.rs#L843).

### 6. Browser playback has no advertised look-ahead limiter

**P1.** The checkbox promises a −1 dB look-ahead limiter, but browser playback uses only gains, biquads and analyzers. It changes static margin, not transient limiting. Native Rust does implement a limiter.

Evidence: [dist/index.html:334](../dist/index.html#L334); [apps/web/src/app.js:1927](../apps/web/src/app.js#L1927).

### 7. Native device recovery can restore an old EQ

**P1.** Profile edits update the processor but not last_request.profile. Reconnect reuses the route-start profile while the UI continues to show later tuning.

Evidence: [src-tauri/src/audio_host.rs:423](../src-tauri/src/audio_host.rs#L423); [src-tauri/src/audio_host.rs:516](../src-tauri/src/audio_host.rs#L516); [src-tauri/src/audio_host.rs:523](../src-tauri/src/audio_host.rs#L523).

### 8. An incomplete bridge handshake can hang the bridge and shutdown

**P1.** The serial listener performs blocking WebSocket handshake acceptance before setting the socket timeout. Bridge destruction joins that worker. A local connection which never finishes the handshake can therefore block new captures and exit. Source-confirmed; no exploit was attempted.

Evidence: [src-tauri/src/extension_bridge.rs:142](../src-tauri/src/extension_bridge.rs#L142); [src-tauri/src/extension_bridge.rs:239](../src-tauri/src/extension_bridge.rs#L239); [src-tauri/src/extension_bridge.rs:271](../src-tauri/src/extension_bridge.rs#L271).

### 9. Switching Direct outputs can leave the old endpoint EQ enabled

**P1.** The output selector overwrites its device ID and clears the UI flag without bypassing the previously selected endpoint. That endpoint's enabled profile remains in its Windows property store. Applies when an associated APO is installed.

Evidence: [apps/web/src/app.js:3401](../apps/web/src/app.js#L3401).

### 10. Exact-tab picker lists tabs without capture grants

**P1.** The extension lists all normal tabs and passes a chosen ID to getMediaStreamId. Chrome requires a capture/invocation grant for the target; opening the popup on one tab does not authorize arbitrary other listed tabs. The advertised selection flow can fail.

Evidence: [extensions/chrome/popup.js:40](../extensions/chrome/popup.js#L40); [extensions/chrome/background.js:32](../extensions/chrome/background.js#L32); [Chrome tab capture contract](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).

### 11. Stop can race native tab startup

**P2.** Startup awaits device refresh, then starts the route before rechecking the cancellation token. Stop during the wait can leave a native output route started after the UI cancels.

Evidence: [apps/web/src/app.js:2383](../apps/web/src/app.js#L2383); [apps/web/src/app.js:2552](../apps/web/src/app.js#L2552); [apps/web/src/app.js:2569](../apps/web/src/app.js#L2569).

### 12. Direct active status does not prove that EQ is processing audio

**P2.** Status derives active from a stored profile enabled bit. It does not establish that the APO is loaded, endpoint effects are enabled, or the playing application traverses that effect path.

Evidence: [src-tauri/src/endpoint_apo.rs:278](../src-tauri/src/endpoint_apo.rs#L278); [src-tauri/src/endpoint_apo.rs:325](../src-tauri/src/endpoint_apo.rs#L325).

### 13. Native routes do not drive L/R VU or spectrum

**P2.** Native status exposes aggregate peaks, but the main VU and spectrum are driven only by the separate Web Audio graph. WASAPI and desktop Chrome capture audio do not feed that graph.

Evidence: [src-tauri/src/audio_host.rs:65](../src-tauri/src/audio_host.rs#L65); [apps/web/src/app.js:554](../apps/web/src/app.js#L554); [apps/web/src/app.js:2062](../apps/web/src/app.js#L2062).

### 14. Solo band is not applied to native DSP

**P2.** Solo/audition is sent to browser analysis only. Native profile publication passes all filters, so visual/browser solo and desktop listening differ.

Evidence: [apps/web/src/app.js:398](../apps/web/src/app.js#L398); [apps/web/src/app.js:483](../apps/web/src/app.js#L483).

### 15. Desktop Chrome capture cannot automatically recover after a DAC reset

**P2.** External input startup clears last_request, and frontend recovery explicitly excludes the extension source. Reconnect automatically does not cover this route.

Evidence: [src-tauri/src/audio_host.rs:488](../src-tauri/src/audio_host.rs#L488); [apps/web/src/app.js:831](../apps/web/src/app.js#L831).

### 16. Chrome-to-DAC sample-rate conversion falls short of the fidelity goal

**P2.** Packets are independently converted with rounded lengths and linear interpolation, without carried fractional phase or an anti-alias filter. 512 frames at 48 kHz produce 470 frames at 44.1 kHz instead of averaging 470.4; this introduces continuous corrective stretching and downsampling quality risks.

Evidence: [extensions/chrome/pcm-worklet.js:6](../extensions/chrome/pcm-worklet.js#L6); [crates/uzjam-audio/src/windows.rs:1444](../crates/uzjam-audio/src/windows.rs#L1444); [crates/uzjam-audio/src/windows.rs:1719](../crates/uzjam-audio/src/windows.rs#L1719).

### 17. Extension transport has no backpressure or stale-audio cap

**P2.** Every PCM block is sent when the socket is open, without bufferedAmount limits or a latency-reset policy. A stalled local bridge can accumulate queued stale audio and memory.

Evidence: [extensions/chrome/offscreen.js:117](../extensions/chrome/offscreen.js#L117).

### 18. Smooth analysis blocks the interface

**P2.** Measured 152–169 ms per analysis for 36 allowed filters on this host. Full rendering can analyze twice, exceeding 300 ms before a frame, and curve dragging invokes synchronous analysis on input events.

Evidence: [apps/web/src/app.js:1545](../apps/web/src/app.js#L1545); [apps/web/src/app.js:1929](../apps/web/src/app.js#L1929).

### 19. Browser processing frequency can disagree with the displayed analysis

**P2.** Web Audio clamps filters to sampleRate × 0.45 while analysis uses the requested frequency. At 44.1 kHz a requested 20 kHz filter processes at 19.845 kHz. Filters at/above Nyquist can also throw in analysis rather than trigger graceful route validation.

Evidence: [apps/web/src/app.js:1973](../apps/web/src/app.js#L1973); [apps/web/src/app.js:2018](../apps/web/src/app.js#L2018).

### 20. Browser input telemetry repeats output telemetry

**P2.** Input and output labels use the same post-EQ peak value. There is no separate pre-EQ input analyzer, so the displayed input/output comparison is false.

Evidence: [apps/web/src/app.js:2080](../apps/web/src/app.js#L2080).

### 21. Basic mode hides all clipping-policy choices

**Requirement gap.** The entire inspector is display:none in Basic. Auto, Lower curve, Smooth peaks and Allow clipping are inside it. Verified in the rendered UI; this directly misses the request for choices in both modes.

Evidence: [dist/styles.css:1419](../dist/styles.css#L1419); [dist/index.html:296](../dist/index.html#L296).

### 22. Zeroed Basic controls do not mean a flat EQ

**UX gap.** Both tone controls and Advanced bands always process together. The initial Advanced bank has nonzero headphone tuning while all six Basic values read 0 dB. Basic gives no explicit view/control of that underlying contribution.

Evidence: [apps/web/src/app.js:118](../apps/web/src/app.js#L118); [apps/web/src/app.js:197](../apps/web/src/app.js#L197); [apps/web/src/app.js:977](../apps/web/src/app.js#L977).

### 23. Saved profiles lose their band-bank layout

**P2.** Saved canonical profiles omit the selected 10/15/30 bank. Hydration loads filters without updating advancedBandCount. A 30-band profile can appear under 10-band labeling and limits.

Evidence: [apps/web/src/app.js:360](../apps/web/src/app.js#L360); [apps/web/src/app.js:3286](../apps/web/src/app.js#L3286).

### 24. Three Settings controls do not implement their promises

**P2.** Default editor is not used at startup; Nearby bands is stored but not consulted; Resume playback stores no playback position and does not restore local file access. Their values render/save without governing the claimed behavior.

Evidence: [apps/web/src/app.js:3394](../apps/web/src/app.js#L3394); [apps/web/src/app.js:3618](../apps/web/src/app.js#L3618); [apps/web/src/app.js:430](../apps/web/src/app.js#L430).

### 25. Unsupported/corrupt audio gets a misleading playback message

**P2.** Extension/MIME acceptance advertises formats without checking decoder support. All play failures become 'Playback needs a tap', and there is no audio error handler for actual decoding failures.

Evidence: [apps/web/src/app.js:2147](../apps/web/src/app.js#L2147); [apps/web/src/app.js:2681](../apps/web/src/app.js#L2681).

### 26. Cancel/Close in Save profile can save the profile

**P2.** Cancel and X are submit buttons on the form. Its submit handler ignores event.submitter and always creates a profile when the required name is filled. With a blank name, native form validation can block those buttons from closing.

Evidence: [dist/index.html:587](../dist/index.html#L587); [apps/web/src/app.js:3282](../apps/web/src/app.js#L3282).

### 27. Global Space shortcut overrides focused buttons

**Accessibility.** The key handler exempts inputs/textareas/selects but not buttons or dialogs. Pressing Space on a focused control can trigger local playback/file selection instead of activating that control.

Evidence: [apps/web/src/app.js:3458](../apps/web/src/app.js#L3458).

### 28. Collapsed navigation and dialogs lack accessible names

**Accessibility.** At the common ≤1420 px desktop width, nav text is display:none and icons have no labels/title. The browser accessibility tree reports unnamed navigation buttons. Dialogs also lack aria-labelledby/aria-label.

Evidence: [dist/styles.css:1732](../dist/styles.css#L1732); [dist/index.html:65](../dist/index.html#L65); [dist/index.html:543](../dist/index.html#L543).

### 29. Readability and control targets remain too small

**UX/accessibility.** Many utility labels use 8–10 px typography, and several controls are 27–34 px targets. This undermines the requested friendly, streamlined interface, particularly at dense desktop layouts and on touch.

Evidence: [dist/styles.css:401](../dist/styles.css#L401); [dist/styles.css:1141](../dist/styles.css#L1141); [dist/styles.css:2423](../dist/styles.css#L2423).

### 30. Library still contains layout examples and lacks music metadata ingestion

**Product gap.** The initial 12 tracks are fictional layout entries with play affordances. Imported files get 'Local file' artist and folder/import album rather than parsed tags/artwork. Library counts and browsing therefore do not reflect a finished music library.

Evidence: [apps/web/src/app.js:132](../apps/web/src/app.js#L132); [apps/web/src/app.js:1603](../apps/web/src/app.js#L1603); [apps/web/src/app.js:2169](../apps/web/src/app.js#L2169).

### 31. Audio object URLs are not released

**P2.** Queue creation allocates blob URLs; removal/clear/replacement never revoke audio URLs. Only JSON export URLs are revoked. Repeated library playback/queue changes can retain file blobs until the page closes.

Evidence: [apps/web/src/app.js:1658](../apps/web/src/app.js#L1658); [apps/web/src/app.js:1778](../apps/web/src/app.js#L1778); [apps/web/src/app.js:3311](../apps/web/src/app.js#L3311).

### 32. System-wide Direct EQ package is not installable

**Release blocker.** The staged APO package explicitly says installable:false. Catalogs, Microsoft driver signing and device-specific extension association remain required before ordinary consumers can use Direct EQ.

Evidence: [APO package status](release-evidence/0.6.0-package-status.json#L2).

### 33. Windows installer and executable are unsigned

**Release gap.** Get-AuthenticodeSignature returned NotSigned for the latest setup executable and standalone uzjam.exe. Installer signing is not present in these artifacts.

Evidence: [0.6.0 build evidence](release-evidence/0.6.0-build-info.json#L12).

### 34. Extension installation requires Developer mode

**Release gap.** The shipped flow requires Load unpacked and a companion folder. There is no Chrome Web Store distribution/install experience.

Evidence: [WINDOWS_BUILD.md:139](../WINDOWS_BUILD.md#L139).

### 35. Compatibility system audio still requires separate endpoints

**Release/architecture gap.** The fallback cannot capture and replay the same physical output transparently. Broad system audio still requires virtual/distinct routing until the Direct package is installable; browser-tab capture only covers selected browser audio.

Evidence: [WINDOWS_BUILD.md:143](../WINDOWS_BUILD.md#L143).

### 36. Broad platform and audio-path compatibility is unfinished

**Scope limitation.** Current native release is Windows x64, shared-mode and stereo-first. macOS/Linux/Android/iOS adapters, exclusive/offload coverage and surround-specific EQ are absent.

Evidence: [WINDOWS_BUILD.md:142](../WINDOWS_BUILD.md#L142); [WINDOWS_BUILD.md:147](../WINDOWS_BUILD.md#L147); [WINDOWS_BUILD.md:152](../WINDOWS_BUILD.md#L152).

### 37. Hosted website is behind the current source

**Release gap.** Sites reports latest saved/deployed version 2 at source adbc55e4b3e3fdf8ba4c91a8d395909d6feb7044, while local/packaged version 0.6.0 is commit 589a87f68bdfbd92b868f6fb8aba89fd59872171. New desktop/browser bridge work is not the code served by that publication.

Evidence: Sites get_site/list_site_versions checked 2026-10-29; [0.6.0 build evidence](release-evidence/0.6.0-build-info.json#L3).

### 38. Passing tests do not establish end-to-end product readiness

**Validation gap.** The suites do not exercise live fader-to-engine behavior, real extension installation/capture, UI preset/backup integration, long-duration DAC resets/clock drift, or standards-based true-peak conformance. Hardware soak and standards measurements remain release work.

Evidence: [extensions/chrome/test/extension.test.mjs:8](../extensions/chrome/test/extension.test.mjs#L8); [WINDOWS_BUILD.md:146](../WINDOWS_BUILD.md#L146); [WINDOWS_BUILD.md:149](../WINDOWS_BUILD.md#L149).

### 39. Extension host permission uses a non-documented scheme

**Compatibility risk.** Manifest declares ws://127.0.0.1/*, while Chrome documents http, https, wildcard and file match-pattern schemes. The declaration requires real Chrome installation validation/correction; an actual browser load rejection was not tested in this audit.

Evidence: [extensions/chrome/manifest.json:14](../extensions/chrome/manifest.json#L14); [Chrome match-pattern rules](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns).

### 40. Website capture accepts missing suppression/surface confirmation

**Compatibility risk.** It rejects suppression only when explicitly false, and wrong display surfaces only when a setting is present. An implementation that ignores constraints and omits settings can pass. Duplicate dry audio or an unintended capture surface is a compatibility risk, not a reproduced current-Chrome failure.

Evidence: [apps/web/src/app.js:2447](../apps/web/src/app.js#L2447); [apps/web/src/app.js:2459](../apps/web/src/app.js#L2459).

## Verification and limits

- `npm test` passed: 16 engine/adapter/preset tests, 10 persistence tests, 3 extension source checks, DSP reference checks and frontend boundary validation.
- `cargo test --workspace --all-targets` passed: 37 tests plus example/bin targets.
- All seven latest release checksum entries matched.
- Both latest Windows executables returned `NotSigned` under Authenticode inspection.
- Local browser preview loaded without console warnings/errors. Basic policy invisibility and unnamed collapsed navigation were verified in the rendered interface.
- No extension was installed, no audio-capture permission was accepted, no hardware route was started and no APO was installed. Audio-chain findings are based on source, existing tests and focused pure-function reproductions, not an end-to-end listening or standards certification session.

The highest-value repair order is fader/engine synchronization, preset/backup/local-file integrity, complete headroom/limiter semantics, native visualizer wiring, route/reconnect correctness, and then signed/distributable packaging.



