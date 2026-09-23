# Audio Capture Roadmap

## Status and Decision

This is the canonical sequencing document for Larmindon's next audio-capture
work. It coordinates two detailed plans:

- [macOS process-level capture](process-level.md)
- [shared capture and spectrogram](spectrogram.md)

Implement macOS process-level capture first, then extract shared capture
ownership for the analyzer. Process capture is an additive platform backend
behind the existing `AudioCapture` abstraction; the analyzer requires a
cross-platform lifecycle and fan-out refactor in the most sensitive part of the
transcription pipeline.

The Tauri repository owns this roadmap because the work crosses core audio,
platform backend selection, the source picker, app identity, signing,
permissions, events, and windows. `larmindon-core/ROADMAP.md` remains focused on
core-library concerns, while the main README describes shipped behavior.

## Non-Negotiable Invariants

- Preserve the working Windows composite backend and WASAPI per-application
  capture. macOS-only code must remain target-gated.
- Preserve ordered, nonduplicated transcription audio and the current fixed-WAV
  transcript goldens unless an intentional DSP change is separately approved.
- Keep one selected source and one OS capture stream. Process capture must not
  introduce simultaneous-source mixing.
- Do not require Soniox credentials for CoreAudio development or regression
  testing. Use deterministic local audio and local Nemotron where transcription
  coverage is useful.
- Keep unsafe CoreAudio ownership small and explicit. Taps and aggregate devices
  must be cleaned up after normal stop, failed initialization, replacement,
  process exit, and drop.
- Treat physical macOS capture and TCC behavior as a separate validation tier
  from compilation and unit tests.
- Use `com.edmistond.larmindon-tauri` for the Tauri app. The existing
  `com.edmistond.larmindon` identifier belongs to the separate SwiftUI app.

## Implementation Order

### Phase 0: Establish identity and regression boundaries

- Change the Tauri bundle identifier to `com.edmistond.larmindon-tauri` before
  granting System Audio Recording permission to a development build.
- Record the current Windows application-capture behavior in tests or a required
  Windows verification job before changing shared capture interfaces.
- Keep `windows_composite` and Windows backend selection unchanged while adding
  the macOS backend.
- Define the macOS integration test as opt-in and hardware/TCC dependent rather
  than part of ordinary cross-platform unit tests.

Exit gate:

- The new app identity is present in the built `.app`.
- The existing Rust tests pass.
- Windows has an explicit compile/test gate capable of catching shared-trait or
  backend-selection regressions.

### Phase 1: Harden the capture contract

- Add fake-backend lifecycle tests for stream start, stop, replacement,
  initialization failure, and cleanup.
- Fix source switching so a new stream's actual metadata reconfigures or
  restarts all format-dependent processing. Do not retain an old sample rate or
  resampler after a source change.
- Clear stale queued audio when replacing a source.
- Preserve the existing transcription resampling, AGC, VAD, ASR, diagnostics,
  and metering path.

Exit gate:

- Fake-backend tests prove cleanup and source replacement behavior.
- The fixed-WAV Nemotron regression gate remains byte-identical.
- Existing platform backends compile without behavioral changes.

### Phase 2: Prove selective macOS process capture

- Enumerate CoreAudio process objects and map them to PID, bundle identifier,
  and running-output state.
- Create a selective tap for one exact process object/PID.
- Create a private aggregate device for that tap and use CPAL for PCM delivery.
- Keep tap and aggregate-device lifetime in one RAII owner.
- Add an opt-in macOS integration test that spawns a known player process,
  captures it by PID, verifies deterministic signal characteristics, and checks
  cleanup.

Exit gate:

- A selected process produces PCM without capturing unrelated system output.
- Stop, process exit, initialization failure, and repeated runs leave no owned
  tap or aggregate device behind.
- The test is reliable after the required TCC permission has been granted.

### Phase 3: Integrate macOS application sources

- Add a macOS composite backend parallel to `windows_composite`.
- Route prefixed macOS application IDs to the process-tap backend and retain
  existing CPAL input/output IDs.
- Begin with exact-PID entries, then group bundled processes by bundle
  identifier while retaining PID-based entries for command-line and unbundled
  processes.
- Evaluate `CATapDescription.isProcessRestoreEnabled` and `bundleIDs` before
  building a custom relaunch watcher.
- Expose macOS application sources through the existing Applications picker.
- Return clear errors for stale processes and denied capture permission.

Exit gate:

- Microphone, whole-system output, and application sources can each be selected
  on macOS.
- Browser/helper grouping and PID fallback have deterministic unit coverage.
- Windows per-application capture still passes its compile/test and live smoke
  gates.

### Phase 4: Validate signed-app permissions and end-to-end behavior

- Build a consistently Apple Development-signed `.app` with bundle identifier
  `com.edmistond.larmindon-tauri`; a production/Developer ID release is not
  required for this validation.
- Confirm the built app contains `NSAudioCaptureUsageDescription`.
- Manually test fresh prompt, allow, deny, relaunch, same-identity rebuild,
  source switch, stop, and app quit.
- Run local end-to-end transcription from a captured player process using the
  committed speech fixture and Nemotron.

Exit gate:

- TCC associates the decision with the Tauri app across relaunch and a rebuild
  signed with the same identity.
- Denial is actionable and does not leak resources.
- Captured-process transcription works without a cloud credential.

### Phase 5: Extract shared capture ownership

- Begin Phase 1 of the [spectrogram plan](spectrogram.md).
- Separate capture state from transcription state and represent consumers
  explicitly.
- Retain the existing transcription processing path behind a compatibility
  adapter initially; do not move common resampling at the same time.
- Give transcription ordered delivery and visualization a separately bounded,
  stale-dropping path.
- Add command acknowledgements and scoped capture, transcription, and
  visualization failures.

Exit gate:

- First/second consumer attach, every detach order, failures, source switching,
  and shutdown are covered with fake backends.
- The fixed-WAV regression gate remains unchanged.
- Microphone, system-output, Windows application, macOS application, and
  PipeWire paths retain their existing behavior.

### Phase 6: Add spectral analysis and the analyzer window

- Add the bounded Rust spectral worker and reduced spectrum protocol.
- Add the Canvas-based analyzer window, capture status, source identity, and
  level meter.
- Validate analyzer-only, transcription-only, and combined operation.
- Measure queue growth, event rate, CPU, memory, and transcription timing before
  tuning FFT and rendering parameters.

Exit gate:

- The day-one acceptance criteria in the spectrogram plan pass.
- Combined mode has no material transcription-output or latency regression.

## Testing Tiers

### Deterministic tests

- Unit-test process enumeration parsing, grouping, ID routing, state changes,
  cleanup decisions, queue boundaries, and source metadata replacement.
- Use fake backends to verify engine lifecycle without opening OS devices.
- Retain `larmindon-core/testdata/check_regression.sh` as the exact transcript
  identity gate.

### Opt-in macOS process-capture integration

Use a committed deterministic tone/envelope fixture for the strong capture
assertion. Spawn `/usr/bin/afplay`, retain its PID, wait for the matching
CoreAudio process object, capture it, then assert expected energy/frequency
features rather than byte equality. The test must have a bounded timeout and
always terminate the child and release CoreAudio resources.

Use the existing committed speech WAV for a separate end-to-end transcription
smoke test. CoreAudio startup offsets and resampling make exact transcript
equality inappropriate for this tier; assert useful expected phrases or a
nonempty result while the direct-WAV gate remains exact.

macOS can generate additional redistributable local speech fixtures without a
cloud service:

```sh
say -v Samantha -r 180 \
  -o fixture.wav \
  --file-format=WAVE \
  --data-format=LEI16@16000 \
  --channels=1 \
  "Larmindon process capture smoke test."
```

`cliamp` remains useful for manual testing of long playback and PID fallback,
especially because a command-line player may not supply a conventional app
bundle identifier. Prefer `afplay` for automation because the harness owns a
single short-lived child process.

### Signed-app/TCC validation

Before the permission matrix, verify the test bundle:

```sh
codesign -dv --verbose=4 /path/to/larmindon.app
codesign --verify --deep --strict /path/to/larmindon.app
```

The signature should report the expected identifier, an Apple signing
authority, and a Team ID rather than `Signature=adhoc`. Do not automatically
reset a developer's normal TCC state in the ordinary test suite; use an
explicit manual reset, a separate macOS account, or a disposable VM for
first-run testing.

### Windows regression protection

Run Windows tests and an application-capture smoke test after any change to
`AudioCapture`, `AudioStream`, `StartedAudioStream`, `CaptureBuffer`, engine
commands, backend selection, or device ID routing. A macOS-only implementation
can still break Windows when it changes these shared seams.

## Documentation Ownership

- Update this roadmap when sequencing or phase gates change.
- Keep platform implementation detail in `process-level.md`.
- Keep shared-capture, FFT, and window detail in `spectrogram.md`.
- Add exact test commands to `larmindon-core/testdata/README.md` only when the
  corresponding harness exists.
- Update the main README when behavior ships; do not describe planned macOS
  application capture as already available.
