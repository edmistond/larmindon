# macOS Process-Level Audio Capture Plan

> **Status:** Planned. This is the detailed plan for Phases 0-4 of the
> [audio-capture roadmap](audio-capture-roadmap.md). Complete this work before
> extracting shared capture ownership for the spectrogram.

## Summary

Process-level audio capture on macOS is feasible and should be implemented as a
contained platform backend rather than as part of the later shared-capture
refactor.

Modern macOS provides native process audio taps through
`AudioHardwareCreateProcessTap` and `CATapDescription`, so supported systems do
not require a Loopback-style virtual audio driver. The initial support boundary
is macOS 14.6 or newer, matching the current CPAL system-audio capture path.

The Tauri app must use bundle identifier `com.edmistond.larmindon-tauri`. The
existing `com.edmistond.larmindon` identifier belongs to the separate SwiftUI
application and must not be reused for this app's signing or TCC records.

## Why It Fits the Existing Architecture

The project already contains most of the cross-platform product and pipeline
infrastructure:

- macOS system-audio capture already uses CoreAudio process taps indirectly
  through CPAL.
- The audio-capture abstraction and frontend already support
  `DeviceType::Application` sources.
- Windows already combines normal CPAL sources with per-process WASAPI capture
  through `windows_composite`.
- The audio engine accepts mono PCM at arbitrary sample rates, so buffering,
  resampling, VAD, ASR, metering, and source selection do not need a structural
  rewrite for this feature.
- `NSAudioCaptureUsageDescription` is already present in the Tauri Info.plist.

Current macOS capture is whole-output-device loopback. CPAL creates a global
tap internally for an output device, but its public API does not accept selected
CoreAudio process object IDs. The project CPAL backend consequently rejects
application IDs.

## Prerequisite: Harden Stream Replacement

Before adding the native backend, fix and test the current reconnect behavior.
It replaces the audio stream while leaving the processing thread's original
input rate and resampler configuration in place. A new source may negotiate a
different format.

The initial safe policy is to restart format-dependent transcription processing
when the source changes, clear queued samples from the old source, and configure
the new path from the returned `AudioStreamMetadata`. Add fake-backend tests for
replacement, metadata changes, initialization failure, and cleanup before
introducing unsafe CoreAudio ownership.

## Target Architecture

Add a macOS composite backend analogous to the existing Windows composite
backend:

1. Enumerate CoreAudio process objects using
   `kAudioHardwarePropertyProcessObjectList`.
2. Read each object's PID, bundle identifier, and
   `kAudioProcessPropertyIsRunningOutput` state.
3. Present eligible processes as `DeviceType::Application` sources with a
   distinct macOS process ID prefix.
4. Route application IDs to a new macOS process-tap backend and retain CPAL for
   existing `input:` and `output:` IDs.
5. Create a `CATapDescription` that includes the selected process object IDs.
6. Create a private CoreAudio aggregate device containing the tap.
7. Use CPAL to capture PCM from the aggregate input device.
8. Own the tap, aggregate device, and CPAL stream together so all exit paths
   clean them up in the correct order.
9. Select the macOS composite backend by default on macOS while leaving Windows
   and Linux backend selection unchanged.

CPAL's CoreAudio loopback implementation is a useful implementation reference,
but its selective tap and hidden-device internals are not public API. Add
target-gated direct CoreAudio/Objective-C bindings for enumeration and tap
ownership, then reuse CPAL only for PCM delivery from the created aggregate
device. Keep this unsafe platform code isolated from the engine.

## Incremental Product Model

### First integration: exact process

Begin with one exact process object/PID. This provides the smallest physically
testable vertical slice and makes stale-process and cleanup behavior clear.
Process IDs are ephemeral and must not be persisted as durable preferences.

### Productized selection: application grouping

A literal process picker can expose Chrome Helper, Teams Helper, browser
renderers, and other implementation details. After exact-PID capture works:

- Group bundled processes by bundle identifier.
- Include all currently relevant CoreAudio process objects for that application
  in one tap.
- Retain PID-based entries for command-line tools and unbundled processes.
- Evaluate `CATapDescription.bundleIDs` and
  `isProcessRestoreEnabled` before implementing a custom relaunch watcher.
- Retain whole-system and physical-input sources already exposed by CPAL.

Manual refresh is sufficient initially. Automatic source-list updates and
relaunch handling are polish after reliable capture and cleanup.

## Permissions and App Identity

- Native process taps were introduced before the project's current macOS 14.6
  minimum; retaining 14.6 avoids creating a second support boundary around the
  current CPAL loopback path.
- `NSAudioCaptureUsageDescription` must be present in the built bundle.
- The operating system prompts when capture is first attempted. Startup must
  return a clear error when permission is denied.
- Test TCC with a consistently Apple Development-signed `.app` whose identifier
  is `com.edmistond.larmindon-tauri`. A production release signature is not
  required, but an ad-hoc build is not an adequate permission test.
- Do not automatically reset normal developer TCC state in the standard test
  suite. Use an explicit reset, separate account, or disposable VM for fresh
  prompt testing.
- BlackHole, Loopback, or another virtual input remains a fallback for older
  systems and custom routing.
- If the app is later sandboxed, reassess its audio entitlements as a separate
  packaging change. The repository currently has no macOS App Sandbox setup.

## Testing Strategy

### Deterministic unit tests

- Process-property parsing and invalid CoreAudio data.
- PID and bundle grouping, sorting, display names, and ID routing.
- Exact-process versus CPAL composite routing.
- Stale process between enumeration and startup.
- Partial initialization cleanup at every resource-acquisition step.
- Stop, replacement, drop, and repeated-start cleanup behavior.
- Source replacement with a different sample rate clears stale audio and
  reconfigures processing.

### Opt-in macOS integration test

Use a committed synthetic signal fixture rather than transcription as the
strong low-level assertion:

1. Spawn `/usr/bin/afplay` and retain its PID.
2. Poll the process-object list with a bounded timeout until that PID is
   producing output.
3. Capture the exact process through the new backend.
4. Assert expected energy, silence/envelope transitions, and frequency peaks.
5. Stop playback and verify all owned CoreAudio resources are released.

This test is macOS-only and requires System Audio Recording permission. It
should be ignored or explicitly enabled during normal test runs rather than
failing cross-platform CI.

Use the existing committed speech WAV for a separate local Nemotron smoke test.
Do not compare that OS-captured transcript byte-for-byte: capture startup and
resampling can shift boundaries. The direct-WAV regression harness remains the
exact transcript gate. No Soniox API key is needed for either test.

For manual PID-fallback testing, a command-line player such as `cliamp` is
useful because it may not present a conventional application bundle identity.
Prefer `afplay` for automation because the test owns a single short-lived child
process.

### Signed-app/TCC matrix

- Fresh permission state prompts with the configured usage description.
- Allow permits process capture.
- Deny produces an actionable error without leaked resources.
- Relaunch retains the decision.
- A rebuild signed with the same identity retains the app association.
- Source switch, stop, and app quit release all resources.

Verify the bundle before the matrix:

```sh
codesign -dv --verbose=4 /path/to/larmindon.app
codesign --verify --deep --strict /path/to/larmindon.app
```

### Windows regression gate

This feature must not change Windows process-capture behavior. Keep the macOS
module behind `#[cfg(all(target_os = "macos", feature = "cpal"))]` and retain
the existing Windows composite selection. Run Windows tests and a live
application-capture smoke test after any shared trait, device-ID, engine, or
backend-selection change.

## Risks and Edge Cases

- A process can exit between enumeration and capture startup.
- Browsers and conferencing applications may move audio among helper processes.
- Some applications may not appear until they initialize or produce audio.
- Bundle identifiers may be missing, malformed, or shared by multiple helper
  processes; PID fallback remains necessary.
- A selected application may relaunch with new process object IDs.
- CoreAudio process lists and aggregate-device discovery may be briefly
  asynchronous.
- Aggregate devices and taps must be destroyed on normal stop, initialization
  failure, stream replacement, process exit, and drop.
- Permission behavior must be checked from the signed app, not inferred from a
  test binary or Terminal session.

## Effort and Delivery Slices

Treat estimates as provisional until exact-PID capture and cleanup work on the
target Mac. Unsafe lifetime behavior and TCC are the uncertainty, not ASR.

| Slice | Expected result |
| --- | --- |
| Capture hardening | Tested source replacement, metadata handling, and cleanup |
| Exact-PID proof | One selected process feeds PCM into the existing engine |
| Integrated feature | Composite backend, picker integration, errors, and tests |
| Product polish | Bundle grouping, restore/relaunch behavior, and source updates |

## Completion Criteria

- The Applications picker exposes eligible macOS applications without removing
  microphone or whole-system sources.
- The selected process, rather than all system output, supplies the captured
  PCM.
- Stale processes and denied permission produce clear errors.
- Every stop, replacement, failure, and quit path releases native resources.
- The direct-WAV transcript regression gate is unchanged.
- The opt-in macOS signal test and signed-app TCC matrix pass.
- Windows per-application capture remains operational and regression-protected.
