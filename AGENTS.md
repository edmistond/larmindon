# AGENTS.md

Real-time speech-to-text desktop app: Tauri v2 backend (Rust) + React frontend. Uses Nemotron streaming ASR via parakeet-rs.

## Build & Run

```sh
cd app  # Must run from app/ subdirectory
npm install            # first time only
npm run tauri dev      # dev build + hot reload
npm run tauri build    # release bundle (.app/.dmg/.exe)
```

Rust-only check (faster when not touching frontend):
```sh
cd app/src-tauri && cargo check
```

## Setup Requirements

**Model Path**: Set via Preferences window (Cmd/Ctrl+, or ⚙️ button) or in `~/.config/larmindon/settings.json`. Default is `~/projects/prs-nemotron/`. Download the [Nemotron streaming model files](https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-speech-streaming-en-0.6b) to your chosen path.

## Verification

No test suite exists. Verify changes by:
1. Running the app and checking live transcription output
2. Querying `larmindon_diag.sqlite` (project root) for timing/events data

## Settings & Environment Variables

Settings are stored in `~/.config/larmindon/settings.json` and editable via the Preferences window. Environment variables override saved settings at runtime:

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `CHUNK_MS` | 80, 160, 560, 1120 | 560 | Nemotron ASR chunk size |
| `INTRA_THREADS` | 1+ | 2 | ONNX intra-op parallelism |
| `INTER_THREADS` | 1+ | 1 | ONNX inter-op parallelism |
| `PUNCTUATION_RESET` | 0/false/no, 1/true/yes | true | Reset decoder at sentence punctuation |
| `LARMINDON_AUDIO_BACKEND` | cpal, pipewire | auto | Force audio backend (Linux) |

Example: `CHUNK_MS=160 INTRA_THREADS=1 npm run tauri dev`

## Feature Flags (Hardware Acceleration)

```sh
npm run tauri dev -- -- --features coreml    # macOS
npm run tauri dev -- -- --features directml  # Windows
```

Note: GPU acceleration is unreliable in practice; CPU inference is default.

## Platform Gotchas

- **macOS**: Requires virtual loopback (BlackHole/Loopback) for system audio capture. No native loopback devices.
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
| `app/src-tauri/src/audio_engine.rs` | Core processing loop, VAD + ASR orchestration, diagnostics logging |
| `app/src-tauri/src/vad.rs` | Silero VAD wrapper with speech/silence state machine |
| `app/src-tauri/src/lib.rs` | Tauri setup, command handlers, engine thread spawn |
| `app/src-tauri/src/settings.rs` | Settings persistence, env var overrides, validation |
| `app/src/App.tsx` | Main frontend (device selector, transcript display) |
| `app/src/Preferences.tsx` | Preferences window (model path, chunk size, fonts, theme) |

### Frontend ↔ Backend Interface

**Commands** (invoke from React): `list_devices`, `start_transcription(device_id)`, `stop_transcription`, `switch_source(device_id)`, `get_settings`, `save_settings`, `get_default_settings`, `get_system_theme`, `get_system_fonts`

**Events** (emit to React): `transcription { text }`, `transcription-error { text }`, `source-switched { device_id }`, `settings-changed { settings }`, `clear-transcript`, `copy-transcript`, `devices-changed`, `open-preferences`

### Windows

Two webview windows: `main` (transcription UI) and `preferences` (settings panel). Defined in `capabilities/default.json`.

## Decoder Behavior (Hard-Won Context)

- **Mid-speech reset**: If Nemotron produces ≥`empty_reset_threshold` (default: 6) consecutive empty chunks during VAD-detected speech, the decoder resets to recover from stuck states. Configurable in Preferences.
- **Punctuation reset**: Decoder resets after `.`, `?`, `!` (excluding `...` and decimals) when enabled (default). Gives clean slate at sentence boundaries.
- **Pre-speech ring buffer**: 500ms audio retained before speech onset for ASR context.

## PipeWire Notes (Linux)

- Use `object.serial` (not `global.id`) for device targeting
- Always set explicit format params (rate, channels, format) when creating capture streams
- Watcher thread auto-reconnects to app streams when they reappear (emits `source-switched`)

## Diagnostics

SQLite database at `larmindon_diag.sqlite` (project root). Tables:
- `sessions` — per-transcription session metadata
- `events` — per-chunk timing (inference_ms, vad_ms, resample_ms, iteration_ms), text preview
- `vad_events` — speech_start, speech_end, mid_speech_reset, punctuation_reset events

See README.md for query examples.

## Attribution Requirements

AI agents must disclose what tool and model they are using in the "Assisted-by" commit footer:

```
Assisted-by: [Model Name] via [Tool Name]
```

**Important**: The git commit header (subject line) should not contain any attribution—attribution belongs only in the commit message body.
