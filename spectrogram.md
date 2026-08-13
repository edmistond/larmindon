# Spectrogram and Shared Audio Capture Plan

## Summary

Add a dedicated sound-analysis window to Larmindon with a scrolling
spectrogram and a conventional level meter. The window serves two related
purposes:

1. Confirm that Larmindon is receiving audio from the selected source.
2. Make the structure of the sound visible, including patterns that may differ
   between speakers, microphones, applications, or environments.

The visualizer must work both with and without captioning. When captioning and
the visualizer run together, they must share one operating-system audio capture
stream rather than open duplicate streams.

This requires separating audio capture from the transcription-session
lifecycle. Capture becomes a shared service, and transcription and
visualization become independent consumers of that service.

The feature is highly achievable. With bounded queues, modest FFT parameters,
and Canvas rendering, its CPU cost should be small compared with local ASR
inference. The main cost is the architectural refactor, not the spectral
analysis itself.

## Product Goals

- Give an immediate, unambiguous answer to "are we getting sound?"
- Show a useful rolling visualization of the captured signal.
- Use the source selected when the spectrogram window is opened.
- Allow the visualizer to run while captioning is inactive.
- Allow captioning and visualization to run concurrently without duplicating
  OS-level capture.
- Let either consumer start or stop without unnecessarily interrupting the
  other.
- Keep transcription reliable and latency-sensitive even if visualization is
  slow, hidden, or unable to keep up.
- Leave a clean path for speaker annotations from diarizing backends later.

## Non-Goals for the First Version

- Speaker-colored spectrogram data.
- Long-term audio recording or playback.
- Saving or exporting spectrogram images.
- Detailed laboratory-grade spectral measurements.
- Multichannel visualization. Larmindon's existing mono capture path is the
  appropriate initial signal.
- Running VAD or loading an ASR model solely for the visualizer.

## Proposed User Experience

The new analyzer window should contain:

- A scrolling, speech-oriented spectrogram.
- A compact RMS/peak level meter.
- The active source name.
- An explicit capture state such as `Capturing`, `Silence`, `Stopped`, or
  `Error`.
- A short rolling time history, initially about 10-20 seconds.

The level meter answers the diagnostic question faster than a spectrogram. The
spectrogram provides the richer view needed to see pitch, harmonic spacing,
formant regions, sibilance, and other speaker/source characteristics. Both are
valuable and should appear together.

Suggested initial display parameters:

- Frequency range: approximately 60 Hz to 8 kHz.
- Frequency axis: logarithmic, or a perceptually useful speech-oriented
  mapping.
- Intensity: decibels mapped to a fixed color palette.
- Time: scrolling left as new columns arrive.
- Visible history: configurable later, fixed at a sensible default initially.

The signal should be analyzed before AGC so the display represents what
Larmindon actually receives from the selected source. This is consistent with
the existing audio level meter, which observes the pre-AGC signal.

## Source and Lifecycle Semantics

The main window remains the owner of the selected-source control.

For the first version:

- Opening the analyzer captures the source selected at that moment.
- The analyzer prominently displays the source to which it is attached.
- If captioning is already using that source, the analyzer attaches to the
  existing capture stream.
- If captioning is idle, opening the analyzer starts capture without starting
  ASR or VAD.
- Starting captioning while the analyzer is open attaches transcription to the
  existing capture service.
- Stopping captioning leaves capture running if the analyzer remains open.
- Closing the analyzer leaves capture running if captioning remains active.
- Capture stops when neither transcription nor visualization needs it.

Changing the selected source while the analyzer is open should eventually
switch all active consumers coherently. It is acceptable to defer live source
switching until after the initial shared-service implementation, provided the
window clearly identifies the source snapshot it is using.

## Target Architecture

```text
Selected audio source
        |
        v
+-------------------------+
| Shared capture service  |
| - owns one OS stream    |
| - tracks source/format  |
| - reports health        |
+-------------------------+
       |             |
       v             v
+---------------+  +-------------------+
| Transcription |  | Spectral analyzer |
| consumer      |  | consumer          |
| lossless,     |  | bounded/latest,   |
| ordered       |  | may drop stale    |
+---------------+  +-------------------+
       |             |
       v             v
 Transcript       Reduced FFT columns
 events           at UI cadence
                         |
                         v
                  Spectrogram webview
```

### Capture service responsibilities

The shared capture service should:

- Own exactly one active OS audio stream.
- Own the identity and native format of the active source.
- Downmix captured data to mono as it does today.
- Fan audio out to registered consumers.
- Start when the first consumer attaches.
- Stop when the final consumer detaches.
- Expose capture state, source identity, native sample rate, and errors.
- Coordinate source changes and notify all consumers.
- Avoid blocking the real-time audio callback.

Capture and transcription state must be represented separately. "Audio is
being captured" and "transcription is running" are no longer synonyms.

### Consumer policies

Each consumer needs independent delivery and backpressure behavior.

#### Transcription

- Receives audio in order.
- Must not silently lose chunks during normal operation.
- Retains priority over visualization.
- Continues to own ASR, VAD, AGC, diagnostics, and transcript events.
- Can attach to or detach from capture without affecting other consumers.

#### Visualization

- Uses a bounded queue or latest-data policy.
- May discard stale audio if it falls behind.
- Must never block capture or transcription.
- Performs spectral reduction outside the audio callback.
- Stops doing FFT/rendering work when the analyzer is closed; it may also
  pause rendering while hidden or minimized.

The current single `CaptureBuffer` is drained by the transcription processing
thread, so it cannot simply be shared by two consumers. The fan-out must happen
before a consumer drains its own queue, or analysis must occur in a common
upstream stage with independently delivered results.

## Data Path and Signal Format

The preferred common analysis signal is mono 16 kHz floating-point PCM, before
AGC. That provides the full frequency range useful to the speech recognizers
and avoids sending the source device's potentially larger native stream to the
UI.

There are two reasonable places to resample:

1. In a common capture-processing stage, once for all consumers.
2. Independently inside consumers when their format requirements differ.

Because transcription already expects 16 kHz and the initial visualizer only
needs speech frequencies up to 8 kHz, sharing one 16 kHz resampling stage is the
preferred end state. Care is required to preserve the current transcription
behavior exactly during the refactor.

Raw full-rate PCM should not cross the Tauri event bridge. The Rust side should
compute reduced spectral columns and send only display-ready values at a
controlled cadence.

## Spectral Analysis

A suitable initial analysis configuration is:

- 16 kHz mono input.
- 512- or 1024-sample FFT.
- Hann window.
- 50-75% overlap.
- Approximately 20-30 emitted display columns per second.
- Magnitudes converted to dB and clamped to a fixed display range.
- Optional aggregation into fewer perceptual/log-frequency bins before
  crossing the Tauri bridge.

The exact parameters should be tuned visually. A 512-sample FFT provides about
32 ms windows and 31.25 Hz raw bin spacing at 16 kHz; a 1024-sample FFT provides
about 64 ms windows and 15.625 Hz bin spacing. The former favors temporal
detail, while the latter favors frequency detail. Either is computationally
small.

Spectral analysis should run in Rust on a dedicated lightweight worker or in a
non-real-time portion of the shared service. Keeping the computation out of the
capture callback ensures that device delivery cannot be stalled by an FFT,
allocation, event emission, or webview behavior.

## Frontend Rendering

Use an HTML Canvas in a dedicated Tauri webview window.

- Do not place every spectral frame in React state.
- Listen for batched or cadence-limited spectral events.
- Update the Canvas imperatively, similar to how the current audio meter
  bypasses React rendering.
- Scroll the existing bitmap and paint only the newest column or small batch of
  columns.
- Resize the backing canvas for device pixel ratio, but cap excessive pixel
  density if profiling shows it is wasteful.
- Pause animation work while the window is not visible.

Canvas 2D should be sufficient. WebGL/WebGPU would add complexity without a
clear need at the expected update rate and window size.

The new window follows the existing caption-overlay pattern:

- Add a dedicated HTML/Vite entry point.
- Add a React component and stylesheet for the analyzer.
- Create/show/focus the webview from a Tauri command and menu or main-window
  control.
- Add the analyzer window label to Tauri capabilities.
- Ensure closing or hiding the window detaches the visualization consumer.

## Commands, Events, and State

Exact names can be chosen during implementation, but the interface will likely
need concepts equivalent to:

### Commands

- `open_audio_analyzer(device_id)`
- `attach_visualizer(device_id)` or an implicit attachment during open
- `detach_visualizer()`
- `start_transcription(device_id)`
- `stop_transcription()`
- `switch_source(device_id)`
- `get_capture_status()`

### Events

- `spectrum-frame` or `spectrum-columns`
- `capture-status`
- `source-switched`
- Existing `audio-level`
- Existing transcription and error events

The service should return acknowledgements for lifecycle-changing commands
rather than merely confirming that an engine command was placed on a channel.
This will keep the UI's independent capture/transcription states honest when a
stream fails to open or a consumer fails to attach.

The existing `transcription-error` event should not be reused for every capture
or analyzer failure. Once capture can outlive transcription, errors need scope:

- A capture failure affects all consumers.
- An ASR failure may stop transcription while visualization continues.
- A visualization failure should not stop transcription.

## Source Switching

Source switching deserves explicit treatment during the refactor.

The current reconnect path replaces the audio stream while leaving the
processing thread's original `input_rate` and resampler configuration in place.
That can be incorrect if the new source negotiates a different native sample
rate or format.

The shared service should make a source change one coherent operation:

1. Stop the old capture stream.
2. Open the new source and obtain its actual metadata.
3. Reconfigure or recreate format-dependent processing.
4. Clear stale queued audio from the old source.
5. Resume all attached consumers.
6. Emit the new source identity and capture state.

Whether transcription's ASR session should remain continuous across a source
change is a separate policy decision. Restarting the transcription session is
safer initially because it prevents old and new sources from sharing decoder,
VAD, diarization, or timing state.

## Performance Expectations and Guardrails

The FFT workload itself should be negligible compared with local Nemotron
inference. A bounded 16 kHz mono analysis stream with a 512- or 1024-point FFT
at 20-30 display updates per second is small on a modern desktop CPU.

The likely incremental costs are:

- One additional webview and Canvas backing store.
- Light continuous CPU use for windowing, FFT, and bin reduction.
- Light GPU/compositor activity while the window is visibly updating.
- Small bounded audio and spectrum queues.

Guardrails:

- Never perform FFTs or event emission in the audio callback.
- Bound every queue.
- Drop stale visualization work rather than accumulate latency.
- Batch spectral columns when helpful to reduce bridge overhead.
- Do not send full-rate PCM to JavaScript.
- Do not initialize ASR, VAD, AGC, or diagnostics for analyzer-only use unless
  a component is explicitly required for the display.
- Stop analysis when no visualizer is attached.
- Stop capture when no consumers are attached.
- Instrument dropped visualization frames and capture-buffer overruns.
- Profile both analyzer-only and analyzer-plus-local-ASR modes before release.

Suggested validation targets, to be confirmed by measurement rather than
treated as hard requirements:

- No measurable change in transcription output or ASR chunk ordering.
- No sustained growth in any queue or window history.
- Analyzer latency remains visually current rather than drifting behind.
- Analyzer-only CPU use remains low on supported hardware.
- Running the analyzer does not materially worsen transcription latency.

## Speaker Diarization Later

Speaker-aware visualization is feasible but should be a later feature.

Use speaker identity as an annotation lane, outline, or translucent overlay
rather than as the primary spectrogram color. Spectrogram color already encodes
signal intensity; overloading it with speaker identity would make the display
harder to interpret.

The current frontend transcript event contains a segment id, finality, text,
and speaker, but not audio timestamps. Soniox tokens contain timestamps before
they are accumulated, and provisional speaker labels may be revised on
finalization. Accurate speaker alignment therefore requires:

- Preserving audio-relative start/end timing through the ASR abstraction.
- Associating spectrum history with the same session clock.
- Applying provisional annotations in a revisable layer.
- Correcting earlier annotations when the backend revises a speaker.
- Defining what happens when a backend has no diarization capability.

This is substantially easier after the shared capture service establishes a
clear capture/session clock and bounded rolling history.

## Implementation Phases

### Phase 1: Extract and verify shared capture ownership

- Separate capture lifecycle from transcription lifecycle.
- Represent attached consumers explicitly.
- Give transcription its own bounded, ordered delivery path.
- Preserve existing transcript, VAD, AGC, diagnostics, and meter behavior.
- Add independent capture and transcription status.
- Verify start, stop, reconnect, shutdown, and error behavior on each supported
  platform.

This phase should avoid adding the visualizer UI. Keeping the refactor isolated
makes transcript-regression testing and code review much safer.

### Phase 2: Add the spectral consumer and protocol

- Add a lossy/bounded visualization delivery path.
- Implement windowing, FFT, dB conversion, and frequency-bin reduction.
- Add spectrum events at a controlled cadence.
- Add capture-health and source metadata needed by the window.
- Unit-test analysis using deterministic tones, silence, and mixed signals.

### Phase 3: Add the analyzer window

- Add the Tauri/Vite window entry point and capabilities.
- Add Canvas spectrogram rendering and the level meter.
- Display source and capture state.
- Wire opening and closing to visualization consumer attachment.
- Ensure analyzer-only use never starts ASR.

### Phase 4: Harden concurrent behavior

- Exercise analyzer-only, transcription-only, and combined modes.
- Test all start/stop orders.
- Test source loss and source switching.
- Test window hide, close, reopen, app quit, and engine errors.
- Measure CPU, memory, bridge event rate, queue depth, and ASR timing.
- Tune FFT size, overlap, batching, and Canvas resolution from measurements.

### Phase 5: Optional enhancements

- Live coherent source switching while the analyzer is open.
- Adjustable history, intensity range, or frequency scale.
- Freeze/inspect mode.
- Speaker annotation lane for diarizing backends.
- Exported screenshots or diagnostic snapshots.

## Testing Strategy

The shared-service refactor touches the most sensitive part of Larmindon's
pipeline, so verification must cover behavior rather than compilation alone.

### Core tests

- First consumer starts capture exactly once.
- Second consumer reuses the active capture stream.
- Detaching one consumer does not stop the other.
- Detaching the final consumer stops capture.
- A slow visualizer drops stale data without delaying transcription.
- Transcription receives ordered, nonduplicated audio.
- Source switching clears old-source audio and reconfigures sample-rate
  handling.
- ASR failure can detach transcription without killing visualization.
- Capture failure is reported to all consumers.
- App shutdown joins all workers and releases the OS stream.

### Spectral tests

- Silence produces the floor value.
- A known sine tone peaks in the expected bin/range.
- Mixed tones produce the expected peaks.
- NaN, infinity, clipping, and unusually large callbacks are handled safely.
- Queue bounds and dropped-frame counters behave as designed.

### Regression verification

- Run the existing Rust checks for `larmindon-core`.
- Run the fixed-WAV ASR behavior-identity gate after changes to the audio
  engine.
- Run frontend tests and production builds.
- Perform live checks with microphone, system output, and application capture
  where supported.
- Compare diagnostics with and without the analyzer running.

## Risks and Mitigations

### Audio duplication or loss during fan-out

This is the highest-risk regression because ASR input must remain exactly once
and ordered. Keep the transcription queue lossless under normal conditions and
cover the fan-out with deterministic sequence-number tests and the existing
WAV regression gate.

### Slow consumer backpressure

Never make the capture callback wait on a consumer. Give visualization a small
bounded queue with explicit stale-frame dropping. Monitor transcription queue
pressure separately and treat it as an engine health issue.

### Lifecycle races

Starting and stopping consumers in different orders can reveal double-stop,
use-after-close, or orphan-thread bugs. Centralize ownership in the capture
service and test every transition as a state machine.

### Cross-platform capture differences

CPAL, Windows process capture, macOS output taps, and PipeWire may deliver
different native formats and have different stop/reconnect behavior. Keep the
service abstraction format-aware and perform platform-specific live checks.

### Webview/event overhead

Reduce and batch data before it crosses the Tauri bridge. Use Canvas drawing
outside React state, and pause visible updates when the window is hidden.

## Day-One Acceptance Criteria

- The analyzer opens from the Larmindon UI or Window menu.
- It displays the source selected when opened.
- It clearly distinguishes active silence from stopped or failed capture.
- It shows a responsive level meter and scrolling spectrogram.
- It works while transcription is stopped without loading an ASR backend.
- Starting transcription while it is open uses the same capture stream.
- Stopping either feature leaves the other running.
- Closing both stops capture and releases resources.
- Visualization cannot block or build unbounded latency behind transcription.
- Transcription output remains identical in the fixed-WAV regression test.
- Combined mode shows no material transcription-latency regression in
  diagnostics on representative hardware.

## Recommended Decision

Proceed with the shared capture service first, followed by a Rust-side spectral
consumer and a Canvas-based analyzer window. This is more work than adding a
special visualizer-only capture mode, but it matches the intended concurrent
use, prevents duplicate OS streams, and creates a sound foundation for future
recording, diagnostics, meters, and speaker-aligned visualization.
