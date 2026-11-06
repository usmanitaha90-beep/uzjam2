# Audit repair branch

This branch implements the [audit findings](UZJAM_AUDIT_2026-10-29.md). It is a development branch; merge and release remain pending final testing.

## Implementation work

- Controls and persistence: live fader updates, recoverable local files, lossless preset handling, validated backup recovery, saved EQ layouts.
- DSP: complete-band headroom analysis, responsive smoothing, matching browser/native frequency handling, browser look-ahead limiting.
- Native audio: latest-profile recovery, bounded bridge handshakes, output switching, source cancellation, native metering and spectrum, streaming rate conversion.
- Chrome extension: explicit source-tab permission flow, valid permissions, transport backpressure, session lifecycle.
- Interface: Basic peak policies, visible underlying tuning, readable controls, accessible navigation/dialogs, reliable cancellation and keyboard behavior, actual music metadata.

Status: implementation in progress. Full regression and listening tests follow implementation, as requested. No production deployment or release is implied by this branch.

## External release requirements

Microsoft driver signing and device-specific APO association require supported hardware packages and signing access. Installer signing requires the owner's signing identity. Chrome Web Store publication requires the owner's developer account. Native macOS/Linux/mobile support and exclusive/surround processing are separate platform deliverables, not completed by Windows bug fixes. These requirements will remain explicitly open until satisfied; none will be labeled fixed by a UI change or a passing unit test.

