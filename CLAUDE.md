# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Tauri desktop app using Rust backend and TypeScript frontend. PipeWire is used for audio capture on Linux.

## Coding

Break work into discrete tasks and commit them in chunks so we can roll back easily if something breaks.

## Build & Run

```sh
cd app
npm install            # install frontend deps (first time)
npm run tauri dev      # development build + hot reload
npm run tauri build    # release build (bundled .app/.dmg/.exe)
```

Rust-only check (faster iteration when not touching frontend):
```sh
cd app/src-tauri && cargo check
```

No test suite exists yet. Verify changes by running the app and checking transcription output + diagnostics DB.

### Environment Variables

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `CHUNK_MS` | 80, 160, 560, 1120 | 560 | Nemotron ASR chunk size in ms |
| `INTRA_THREADS` | 1+ | 2 | ONNX intra-op parallelism (within operations) |
| `INTER_THREADS` | 1+ | 1 | ONNX inter-op parallelism (between operations) |
| `PUNCTUATION_RESET` | 0/false/no, 1/true/yes | true | Reset decoder at sentence-ending punctuation |

Example: `CHUNK_MS=160 INTRA_THREADS=1 npm run tauri dev`

### Cargo Feature Flags

- `coreml` — macOS CoreML (unreliable in practice)
- `directml` — Windows DirectML
- `migraphx` — AMD MIGraphX

Enabled via: `npm run tauri dev -- -- --features coreml`

## Architecture

Real-time speech-to-text desktop app: Tauri v2 backend (Rust) + React frontend.

### Threading Model

```
Main thread (Tauri)
  └─ Engine thread (receives Command via mpsc)
       ├─ CPAL audio callback thread → pushes mono f32 into Arc<Mutex<VecDeque<f32>>>
       └─ Processing thread (per session)
            ├─ Drains shared buffer
            ├─ Resamples to 16kHz (rubato, if device rate differs)
            ├─ VAD gating (Silero ONNX, 512-sample/32ms frames)
            └─ ASR inference (Nemotron via parakeet-rs, configurable chunk size)
```

- Threads communicate via `std::sync::mpsc` channels and `Arc<AtomicBool>` stop flags
- No async/tokio — all standard OS threads
- ONNX Runtime spawns its own internal thread pool (controlled by `INTRA_THREADS`)

### Frontend ↔ Backend Interface

**Tauri commands** (invoked from React): `list_devices`, `start_transcription(device_id)`, `stop_transcription`

**Tauri events** (emitted to React): `transcription { text }`, `transcription-error { text }`

### Key Files

- `app/src-tauri/src/audio_engine.rs` — Core processing loop, audio capture, VAD + ASR orchestration, SQLite diagnostics logging. This is the main file for backend changes.
- `app/src-tauri/src/vad.rs` — Silero VAD wrapper with speech/silence state machine and pre-speech ring buffer
- `app/src-tauri/src/lib.rs` — Tauri setup, command handlers, engine thread spawn
- `app/src-tauri/src/audio_config.rs` — Audio device config negotiation
- `app/src/App.tsx` — Entire frontend (single component)

### Diagnostics

SQLite database at `larmindon_diag.sqlite` (project root). Tables: `sessions`, `events`, `vad_events`. Every transcription chunk logs timing (inference_ms, vad_ms, resample_ms, iteration_ms), VAD state, and text preview. See README.md for query examples.

### Notable Design Decisions

- **MODEL_PATH is hardcoded** (`/Users/edmistond/Downloads/prs-nemotron`) — will need to be made configurable
- **VAD is single-threaded** (intra=1, inter=1 in vad.rs) since it's lightweight (~0ms per frame)
- **Mid-speech reset**: If Nemotron produces ≥6 consecutive empty chunks during VAD-detected speech, the decoder resets to recover from stuck states
- **Pre-speech ring buffer**: 500ms of audio is retained before speech onset so the ASR gets context before the first voiced frame
- **Punctuation-based decoder reset**: When enabled (default), the decoder resets after emitting text ending with `.`, `?`, or `!` (excluding ellipsis and decimals). Complementary to the mid-speech empty-chunk reset — gives the decoder a clean slate at sentence boundaries
- **macOS needs virtual loopback** (e.g., BlackHole or Loopback) for system audio capture

## Bug Fixes

When fixing bugs, verify the fix actually works before committing. If a first attempt doesn't resolve the issue, re-examine assumptions about scope, thread lifecycle, and shared state before retrying.

## PipeWire Notes

For PipeWire integration: use `object.serial` (not `global.id`) for device targeting. Always set explicit format params (rate, channels, format) when creating capture streams.

## Rust Patterns

When spawning background threads or watchers in Rust, ensure the handle is stored/held to prevent immediate drop. Check that shared stop flags don't inadvertently kill sibling threads.
