# UZjam Windows build and run guide

UZjam's Windows product is a Tauri v2 desktop shell around the shared web UI and portable Rust DSP. It offers an exact-tab Chrome extension route with no virtual cable, a preferred endpoint APO for in-place system-wide EQ, plus the explicit WASAPI source-to-output route as a compatibility fallback.

## Prerequisites

- Windows 11 22H2 or newer, 64-bit, for the endpoint APO and per-user effects property store. The compatibility WASAPI route also builds on Windows 10.
- Node.js 22 or newer with npm.
- Stable Rust with the `x86_64-pc-windows-msvc` target.
- Microsoft Visual Studio Build Tools 2022 with **Desktop development with C++** and a Windows SDK.
- Windows Driver Kit 11 for `InfVerif`, `Inf2Cat`, HLK work, and production APO packaging. The APO DLL itself can be built with the Windows SDK headers and libraries already installed with current Visual Studio.
- Microsoft Edge WebView2 Runtime. It is already present on supported Windows 10/11 installations in normal configurations.

After installing Rust, confirm that its default host is MSVC:

```powershell
rustup show
```

## Run for development

From the repository root:

```powershell
npm ci
npm run desktop:dev
```

The desktop command starts the web development build and launches the native shell. Closing the window stops the active route, releases device handles, and flushes the current settings/profile snapshot.

## Install the Chrome tab picker

Build the unpacked extension and its distribution zip:

```powershell
npm run build:extension
```

Then:

1. Open `chrome://extensions` in Chrome 116 or newer.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose `target\extension\uzjam-tab-audio-0.6.0`.
4. Pin **UZjam Tab Audio** to the Chrome toolbar.
5. In the UZjam app, choose your DAC under **Settings → Windows audio → Listening output**.
6. Choose **Source → Browser tab**, copy the pairing code, then click the Chrome extension and select a tab.

The pairing code is generated locally, persists for this Windows user, and is stored by the extension after the first connection. Audio travels as stereo float PCM over a WebSocket bound to `127.0.0.1`; it is never uploaded. Chrome's unprocessed tab playback is suppressed while UZjam renders the processed signal to the selected DAC.

For UI-only work without the native audio route:

```powershell
npm run build
python -m http.server 4173 --directory dist
```

Then open `http://localhost:4173`. This mode can process local files and an explicitly shared browser tab only.

## Prepare a clean DAC output

For the current unsigned compatibility route, remove other software processing from the physical output before listening. The checked-in helper targets one named render endpoint, disables its driver-installed Windows system effects through the Core Audio property store, stops Boom 3D, disables Boom's per-user startup task, and verifies Spatial Audio state:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\configure-windows-clean-audio.ps1 -EndpointName "TOPPING USB DAC"
```

The default command is user-scoped where possible and does not uninstall drivers, disable the DAC, or modify unrelated Razer/THX devices. If more than one device matches, the helper stops and prints the endpoint IDs rather than guessing. Reopen UZjam and the player after changing the endpoint processing state so both create fresh audio streams.

Use this route for the current machine:

1. Set the Windows default output to `CABLE In 16ch`.
2. In UZjam, select `CABLE In 16ch — System mix` as the capture source.
3. Select `Speakers (TOPPING USB DAC)` as the processed output.
4. Start with a 256-frame buffer, Auto headroom, the limiter enabled, and bypass off.

To restore Windows endpoint effects and allow a future signed UZjam endpoint APO to load on the DAC:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\configure-windows-clean-audio.ps1 -EndpointName "TOPPING USB DAC" -Restore
```

`-Restore` re-enables Boom's registered startup task but does not launch Boom. `-SkipBoom` leaves Boom's state untouched. The clean-audio mode disables all driver-installed endpoint effects, including UZjam itself if a signed direct endpoint package is later associated with that same DAC; use `-Restore` before testing direct APO mode.

## Verify everything

```powershell
npm test
npm run validate:schema
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
powershell -ExecutionPolicy Bypass -File .\tools\build-windows-apo.ps1
```

The APO build compiles the Rust bridge and C++ COM server, then loads the resulting DLL into a native smoke test that verifies COM interfaces, format negotiation, the reported 5 ms latency, and sample-accurate delayed DSP output. It also stages the component INF and device-extension template under `target\apo\x64\release\package` without installing them.

## Direct endpoint package

The package source is split intentionally:

- `windows\apo\package\uzjam-apo-component.inf` registers and stores the UZjam APO DLL as a Windows 11 `AudioProcessingObject` software component.
- `windows\apo\package\uzjam-device-extension.template.inf` shows the device-specific extension that associates the UZjam endpoint effect with a render topology.

For a production release, replace the extension template's hardware-ID and topology-reference placeholders for each supported audio driver, assign a unique extension ID per shipped package, run `InfVerif`, generate catalogs with `Inf2Cat`, pass APO/HLK validation, and submit the packages for Microsoft driver signing. Do not register the raw DLL with `regsvr32`: endpoint APO discovery and isolation depend on the driver-store package and device association.

The build script deliberately marks `package-status.json` as non-installable and never modifies an active audio endpoint. This prevents an unsigned development binary from being loaded into the Windows audio service.

## Produce a Windows release

Use the checked-in release driver from a normal PowerShell prompt:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-windows-release.ps1
```

The script performs a clean npm install, runs every validation gate, invokes `npm run desktop:build`, and collects the Windows executable/installer under a timestamped `release\windows-*` directory. That directory also contains:

- `SHA256SUMS.txt` for artifact verification;
- `build-info.json` with tool versions, source revision, and validation status.
- `uzjam-tab-audio-extension\` for Chrome's **Load unpacked** flow, plus a matching zip for transport.

For a repeat build after dependencies and tests have already passed:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-windows-release.ps1 -SkipInstall -SkipValidation
```

Do not publish a build made with `-SkipValidation` as a production release.

## Presets and settings

- A portable EQ preset uses the canonical `.uzjam.json` profile format. It contains filter, channel, preamp, protection, target, and optional device-binding intent; it does not contain machine-specific audio handles.
- Full application backups use the `uzjam-settings-backup` envelope. State writes are staged before commit and retain the prior valid snapshot, so an interrupted write can recover from pending or last-known-good data.
- Settings are local to the Windows user/WebView profile. No audio or profile data is uploaded.

## Current Windows limitations

- The direct endpoint code is complete and smoke-tested, but it is not installable on arbitrary consumer hardware until its component and per-device extension packages are cataloged, Microsoft-signed, and associated with supported driver families.
- Exact-tab mode requires Chrome 116 or newer and the unpacked companion extension. Chrome Web Store publication is a separate distribution step.
- Chrome internal pages, protected media, enterprise capture policies, and DRM can prevent a tab from being captured.
- The extension route is stereo-first. It uses lightweight linear conversion when Chrome and the selected DAC expose different shared-mode sample rates.
- Exclusive-mode or hardware-offload applications can bypass shared endpoint effects.
- If direct mode is unavailable, the compatibility route still cannot feed loopback capture back to the same physical endpoint without duplicated dry audio. Use a distinct source/output route for that fallback.
- Endpoint resets trigger bounded recovery of the exact last-working route when **Reconnect automatically** is enabled. Missing or renamed devices are never substituted; topology changes still require manual selection.
- Latency is a requested buffer target, not a guarantee. Windows and the selected devices negotiate the actual period.
- Separate capture/render clocks are kept near the queue target with single-frame, block-wide linear corrections. This prevents slow queue drift, but it is not a user-selectable mastering-grade asynchronous sample-rate converter; long-duration hardware soak testing remains release work.
- The DSP path is stereo-first. Multichannel content is outside this MVP.
- The APO EQs the first stereo pair and latency-aligns remaining channels rather than applying surround-channel-specific correction.
- `limiterEnabled` inserts the shared stereo-linked 5 ms look-ahead limiter. Its 4× interpolated peak detector and hard ceiling are tested for digital overs, but it is not a standards-certified broadcast true-peak implementation. Auto headroom remains the default transparent protection mechanism.
- Release artifacts are unsigned unless Windows code-signing credentials are configured outside the repository. Unsigned installers can trigger Microsoft Defender SmartScreen and are not suitable for broad production distribution.
- The NSIS installer uses the WebView2 download bootstrapper when the runtime is absent, so first installation can require internet access.
- macOS, Linux, Android, and iOS adapters are not included in this Windows build. The profile and DSP crates remain platform-neutral for those future adapters.

## Troubleshooting

**`link.exe` is missing**

Install the Visual Studio C++ workload and Windows SDK, then reopen the terminal.

**The desktop window opens but no device is available**

Confirm Windows has an enabled playback endpoint, allow desktop apps to access audio where applicable, and refresh the device list.

**A route will not start**

Avoid selecting the same endpoint for loopback capture and processed render, close applications holding a device in exclusive mode, then retry with the default buffer target.

**The Chrome extension says UZjam is not listening**

Open the desktop app first, choose **Source → Browser tab**, and confirm the pairing code matches. If the app reports a bridge error, check whether another process is using ports `39847` through `39857` on localhost.

**The DAC sounds doubled, spatialized, or unexpectedly loud**

Run `tools\configure-windows-clean-audio.ps1` for the physical output, confirm Spatial Audio reports off, and verify Windows is playing to the virtual-cable input rather than directly to the DAC. Do not run Boom, THX, or another system-wide enhancer in parallel with UZjam.

**Settings were recovered on launch**

UZjam detected an incomplete or invalid primary state and loaded the staged or last-known-good snapshot. Export a full backup after confirming the recovered profile.
