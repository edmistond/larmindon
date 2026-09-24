# AGENTS.md

Real-time speech-to-text desktop app: Tauri v2 backend (Rust) + React frontend.
Uses Nemotron streaming ASR via parakeet-rs.

## Build Commands
- Use `npm run tauri build` (not `cargo tauri build`) for Tauri builds
- Run npm commands from the `app/` directory, not the repo root
- Prefix npm or cargo commands that may download dependencies with `sfw` so they
  go through Socket Firewall Free. For example, use `sfw npm install`,
  `sfw cargo fetch`, or `sfw cargo install ...` instead of running dependency
  fetch/install commands directly.

## Source Control

Use Git for source control. `larmindon` and `larmindon-core` are separate Git
repositories; run Git commands from the repository you intend to change.

## Committing Changes

Keep commits focused so a change can be reviewed or reverted independently.

Before committing, make sure to run `cargo fmt` and `cargo clippy --fix` against
`app/src-tauri` - address any changes recommended by clippy, if it cannot apply
an automatic fix.

### Git Commits
- Do not add 'Assisted-by' lines; use only the standard 'Co-authored-by' trailer
- Verify implementation is wired up end-to-end before committing (e.g., feature flags must actually be referenced in code)

## Build & Run

```sh
sfw npm install        # first time only
npm run tauri dev      # dev build + hot reload
npm run tauri build    # release bundle (.app/.dmg/.exe)
npm run tauri:webgpu   # macOS WebGPU release bundle with libwebgpu_dawn.dylib
npm run tauri:webgpu:full # macOS WebGPU full bundle set
```

Rust-only check (faster when not touching frontend):
```sh
cd app/src-tauri && cargo check
```

## Setup Requirements

* **Model Path**: Set via Preferences window (Cmd/Ctrl+, or ⚙️ button) or in
  `~/.config/larmindon/settings.json`. Default is `~/projects/prs-nemotron/`.
  Download one of these to your chosen path (`encoder.onnx`,
  `encoder.onnx.data`, `decoder_joint.onnx`, `tokenizer.model`):
  * [Nemotron English](https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-speech-streaming-en-0.6b)
  * [Nemotron 3.5 multilingual](https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-3.5-asr-streaming-0.6b-onnx)
    (40 locales; pick one under Preferences → Nemotron → Language, or leave
    it on auto-detect)

  parakeet-rs tells the two apart from the files, so switching models means
  changing the path.
* **Diarization model** (optional): Speaker labels for Nemotron come from
  [`nemotron3_diar_v3.onnx`](https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-3-diarization)
  (Sortformer v3, ~380 MB), expected at `~/models/nemotron3_diar_v3.onnx`
  (Preferences → Nemotron → Diarization Model). On by default; without the
  file, Nemotron runs without speakers. Both models stay loaded between
  sessions: about 2.4 GB for the encoder plus the diarizer.

## Verification

- Frontend: `npm test` in `app/` (vitest; `transcriptStore.test.ts`).
- Engine/ASR: `cargo test` and `bash testdata/check_regression.sh` in
  `larmindon-core` (see its AGENTS.md for when the gate is required).
- End to end: run the app and check live transcription, then query
  `~/.config/larmindon/larmindon_diag.sqlite` for timing/events data.

## Settings & Environment Variables

Settings are stored in `~/.config/larmindon/settings.json` and editable via the
Preferences window. Environment variables override saved settings at runtime:

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `CHUNK_MS` | 80, 160, 560, 1120 | 560 | Nemotron ASR chunk size |
| `INTRA_THREADS` | 1+ | 2 | ONNX intra-op parallelism |
| `INTER_THREADS` | 1+ | 1 | ONNX inter-op parallelism |
| `PUNCTUATION_RESET` | 0/false/no, 1/true/yes | true | Reset decoder at sentence punctuation |
| `NEMOTRON_LANG` | auto, en-US, es-ES, … | auto | Nemotron 3.5 target language (ignored by the English model) |
| `NEMOTRON_DIARIZATION` | 0/false/no, 1/true/yes | true | Label Nemotron output with Sortformer speakers |
| `LARMINDON_AUDIO_BACKEND` | cpal, pipewire | auto | Force audio backend (Linux) |

Example: `CHUNK_MS=160 INTRA_THREADS=1 npm run tauri dev`

## Feature Flags (Hardware Acceleration)

```sh
npm run tauri dev -- -- --features webgpu    # macOS (Metal via WebGPU)
npm run tauri:directml:dev                   # Windows (DirectML)
npm run tauri:webgpu                         # macOS release bundle
npm run tauri:directml                       # Windows release bundle
```

Do not use `npm run tauri build -- --features webgpu` for macOS WebGPU release builds.
It skips `src-tauri/webgpu.conf.json`, so the `.app` will link `@rpath/libwebgpu_dawn.dylib`
without bundling that dylib into `Contents/Frameworks`.

Note: GPU acceleration is experimental; CPU inference is default. A new execution
provider needs a feature flag in both `app/src-tauri/Cargo.toml` and
`larmindon-core/Cargo.toml`, and must then be wired up in
`larmindon-core/src/asr/nemotron.rs` via `ExecutionConfig::with_execution_provider()`
behind a `#[cfg(feature = "...")]` block — the feature flag alone only makes the
provider available at compile time.

## Platform Gotchas

- **macOS**: Uses CPAL/CoreAudio output monitors for native system audio capture on macOS 14.6+; BlackHole/Loopback remain useful fallbacks for older macOS versions or custom routing.
- **Linux**: Uses PipeWire by default; falls back to CPAL with `LARMINDON_AUDIO_BACKEND=cpal`.

## Architecture Quick Reference

### Threading Model

```
Main thread (Tauri)
  └─ Engine thread (mpsc command dispatch)
       ├─ CPAL audio callback → pushes mono f32 to shared buffer
       └─ Processing thread (per session)
            ├─ Drains buffer → resample? → VAD → ASR → emit event
```

- No async/tokio — all OS threads
- Communication: `std::sync::mpsc` channels + `Arc<AtomicBool>` stop flags

### Key Files

| File | Purpose |
|------|---------|
| `../larmindon-core/src/audio_engine.rs` | Core processing loop, VAD + ASR orchestration, diagnostics logging |
| `../larmindon-core/src/vad.rs` | Silero VAD wrapper with speech/silence state machine |
| `app/src-tauri/src/lib.rs` | Tauri setup, command handlers, engine thread spawn |
| `../larmindon-core/src/settings.rs` | Settings persistence, env var overrides, validation |
| `app/src/App.tsx` | Main frontend (device selector, transcript display) |
| `app/src/Preferences.tsx` | Preferences window (model path, chunk size, Nemotron language and diarization, fonts, theme) |

### Frontend ↔ Backend Interface

**Commands** (invoke from React): `list_devices`, `start_transcription(device_id)`, `stop_transcription`, `switch_source(device_id)`, `open_caption_overlay`, `set_caption_overlay_interactive`, `get_settings`, `save_settings`, `get_default_settings`, `has_soniox_api_key`, `get_nemotron_languages`, `get_system_theme`, `get_system_fonts`

**Events** (emit to React): `transcript-update { segment_id, is_final, text, speaker }`, `transcription-error { text }`, `engine-status { level, text }`, `audio-level { level, vad_active }`, `source-switched { device_id }`, `settings-changed { settings }`, `overlay-interaction-changed`, `clear-transcript`, `copy-transcript`, `devices-changed`, `open-preferences`

Transcript is delivered as segments, not appended text. A segment may be
re-sent with `is_final: false` while a backend revises it, then finalized once;
`text` is always the segment's complete text. Nemotron with diarization emits
each chunk provisionally with the current speaker, then finalizes it about a
second later with the diarizer's label. `app/src/transcriptStore.ts` folds
finalized segments into speaker turns and is unit-tested (`npm test` from `app/`).

`get_settings` and `settings-changed` carry the **redacted** settings — the
Soniox API key is blanked, so it never reaches a webview or the
`larmindon_settings` localStorage mirror. `save_settings` treats an empty
incoming key as "keep the stored one"; use `has_soniox_api_key` to tell whether
one is saved.

### Windows

Three webview windows: `main` (transcription UI), `preferences` (settings panel) and `caption_overlay` (floating captions). Defined in `capabilities/default.json`.

## Decoder Behavior (Hard-Won Context)

- **Mid-speech reset**: If Nemotron produces ≥`empty_reset_threshold` (default: 6) consecutive empty chunks during VAD-detected speech, the decoder resets to recover from stuck states. Configurable in Preferences.
- **Punctuation reset**: Decoder resets after `.`, `?`, `!` (excluding `...` and decimals) when enabled (default). Gives clean slate at sentence boundaries.
- **Pre-speech ring buffer**: 500ms audio retained before speech onset for ASR context.

## PipeWire Notes (Linux)

- Use `object.serial` (not `global.id`) for device targeting
- Always set explicit format params (rate, channels, format) when creating capture streams
- Watcher thread auto-reconnects to app streams when they reappear (emits `source-switched`)

## Diagnostics

SQLite database at `~/.config/larmindon/larmindon_diag.sqlite`. Tables:
- `sessions` — per-transcription session metadata
- `events` — per-chunk timing (inference_ms, vad_ms, resample_ms, iteration_ms), text preview
- `vad_events` — speech_start, speech_end, mid_speech_reset, punctuation_reset events

See README.md for query examples.
