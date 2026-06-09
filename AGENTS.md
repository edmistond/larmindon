# AGENTS.md

Real-time speech-to-text desktop app: Tauri v2 backend (Rust) + React frontend.
Pluggable speech engines from the larmindon-core workspace: Nemotron
(parakeet-rs, append-only finals) and April ASR (april-asr, streaming
partial/final segments).

## Build Commands
- Use `npm run tauri build` (not `cargo tauri build`) for Tauri builds
- Run npm commands from the `app/` directory, not the repo root
- Prefix npm or cargo commands that may download dependencies with `sfw` so they
  go through Socket Firewall Free. For example, use `sfw npm install`,
  `sfw cargo fetch`, or `sfw cargo install ...` instead of running dependency
  fetch/install commands directly.

## Committing Changes

Commit changes frequently in git to checkpoint them.

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

* **Nemotron model**: set the model directory in Preferences (Cmd/Ctrl+, or ⚙️
  button) under the engine section, or in `~/.config/larmindon/settings.json`
  (`engines.nemotron.model_path`). Download the
  [Nemotron streaming model files](https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-speech-streaming-en-0.6b).
* **April model**: a single `.april` file (e.g.
  [aprilv0_en-us.april](https://april.sapples.net/aprilv0_en-us.april));
  set `engines.april.model_path` via Preferences.
* **April build/runtime deps**: cmake + libclang at build time;
  `brew install onnxruntime` at runtime (macOS). The app build script keeps a
  locally re-signed copy at `~/.config/larmindon/runtime/libonnxruntime.dylib`
  because Gatekeeper blocks homebrew's foreign-ad-hoc-signed dylib, and
  rewrites the built libaprilasr to load that copy.

## Verification

No frontend test suite exists (the core workspace has unit tests). Verify
changes by:

1. Running the app and checking live transcription output
2. Querying `larmindon_diag.sqlite` (project root) for timing/events data

## Settings & Environment Variables

Settings are stored in `~/.config/larmindon/settings.json` (format v2:
shared fields at the top level, per-engine config under `engines.<id>`,
selection via `active_engine`; v1 flat files are migrated automatically with a
`settings.json.v1.bak` backup). Environment variables override saved settings
at runtime:

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `LARMINDON_ENGINE` | nemotron, april | saved value | Active speech engine |
| `CHUNK_MS` | 80, 160, 560, 1120 | 560 | Nemotron ASR chunk size |
| `INTRA_THREADS` | 1-32 | 2 | Nemotron ONNX intra-op parallelism |
| `INTER_THREADS` | 1-32 | 1 | Nemotron ONNX inter-op parallelism |
| `PUNCTUATION_RESET` | 0/false/no, 1/true/yes | true | Reset decoder at sentence punctuation |
| `LARMINDON_AUDIO_BACKEND` | cpal, pipewire | auto | Force audio backend (Linux) |
| `ORT_DYLIB_PATH` | path | auto-discovered | ONNX Runtime dylib (load-dynamic builds) |

Engine env overrides are declared by each engine's `ConfigField::env_var`
descriptor in its crate — adding one there makes it work automatically.

Example: `CHUNK_MS=160 INTRA_THREADS=1 npm run tauri dev`

## Feature Flags

Engines are compile-time features (both on by default): `engine-nemotron`,
`engine-april`. Hardware acceleration (Nemotron only):

```sh
npm run tauri dev -- -- --features webgpu    # macOS (Metal via WebGPU)
npm run tauri dev -- -- --features directml  # Windows
npm run tauri:webgpu                         # macOS release bundle (.app only)
npm run tauri:webgpu:full                    # macOS release, all bundle types
```

### WebGPU with both engines (load-dynamic builds)

Because `engine-april` flips `ort` to dynamic loading of a single shared
libonnxruntime (see larmindon-core AGENTS.md), WebGPU comes from that shared
dylib — and homebrew's onnxruntime is built WITHOUT the WebGPU EP. To get
WebGPU-accelerated Nemotron alongside April in one binary, drop a
WebGPU-enabled build (e.g. Microsoft's official release dylib from
`onnxruntime-osx-arm64-<ver>.tgz`, which statically includes Dawn) at:

```
~/.config/larmindon/runtime/libonnxruntime.source.dylib
```

The app build script prefers that file over the package-manager install when
refreshing the locally-signed managed copy. No `libwebgpu_dawn.dylib` or
`webgpu.conf.json` is involved in this flow — `tauri:webgpu` is just
`tauri build --features webgpu`.

`src-tauri/webgpu.conf.json` (bundling pyke's `libwebgpu_dawn.dylib`) only
applies to static-ort builds, i.e. builds WITHOUT `engine-april`; keep it for
a self-contained redistributable Nemotron-only bundle.

Note: GPU acceleration is experimental; CPU inference is default. When adding a new
execution provider feature flag, wire it through `larmindon-engine-nemotron`
(`ExecutionConfig::with_execution_provider()` in its `begin_session`) — the
feature flag alone only makes the provider available at compile time.

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
            ├─ Drains buffer → resample? → AGC → VAD → SpeechEngine → segment events
                 └─ (April only) worker thread owning the !Send model/session
```

- No async/tokio — all OS threads
- Communication: `std::sync::mpsc` channels + `Arc<AtomicBool>` stop flags

### Engine Abstraction (larmindon-core workspace)

- `SpeechEngine` trait: VAD-gated `feed(samples)`, `on_speech_start/end`,
  non-blocking `poll()` for engines whose results arrive asynchronously.
- Results are `SegmentUpdate { segment_id, text, is_final }`. Transient
  segments (`is_final: false`) are replaced wholesale by later updates with
  the same id; Nemotron only ever emits finals, April emits partial→final.
- `EngineFactory`/`EngineRegistry`: each engine declares an
  `EngineDescriptor` with typed config fields; Preferences renders the engine
  section dynamically from it. Engine instances (and their loaded models) are
  cached across sessions keyed by engine id + factory cache key; switching
  engines requires Stop/Start, not an app restart.

### Key Files

| File | Purpose |
|------|---------|
| `larmindon-core/crates/larmindon-core/src/audio_engine.rs` | Processing loop: drain → resample → AGC → VAD → engine dispatch |
| `larmindon-core/crates/larmindon-core/src/engine/` | SpeechEngine trait, registry/descriptors, segment id tracker |
| `larmindon-core/crates/larmindon-engine-nemotron/src/lib.rs` | Nemotron engine: chunking, punctuation/stuck-decoder resets |
| `larmindon-core/crates/larmindon-engine-april/src/lib.rs` | April engine: worker thread, partial/final mapping |
| `larmindon-core/crates/larmindon-core/src/settings.rs` | Settings v2 persistence, migration, validation |
| `app/src-tauri/src/lib.rs` | Tauri setup, registry wiring, command handlers |
| `app/src-tauri/build.rs` | rpaths + locally-signed libonnxruntime copy for April |
| `app/src/App.tsx` | Main frontend (device selector, segment-based transcript) |
| `app/src/CaptionOverlay.tsx` | Always-on-top caption overlay (segment-based rolling window) |
| `app/src/Preferences.tsx` | Preferences window (engine selector + descriptor-driven fields) |

### Frontend ↔ Backend Interface

**Commands** (invoke from React): `list_devices`, `list_engines`, `start_transcription(device_id)`, `stop_transcription`, `switch_source(device_id)`, `get_settings`, `save_settings`, `get_default_settings`, `get_system_theme`, `get_system_fonts`

**Events** (emit to React): `transcription-update { segment_id, text, is_final }`, `transcription-error { text }`, `source-switched { device_id }`, `settings-changed { settings }`, `clear-transcript`, `copy-transcript`, `devices-changed`, `open-preferences`

Transient segments render dimmed (`.transcript .transient`) in the main
window and update in place; the caption overlay renders them uniformly and
only evicts finalized segments from its rolling window.

### Windows

Two webview windows: `main` (transcription UI) and `preferences` (settings panel), plus the `caption_overlay` created on demand. Defined in `capabilities/default.json`.

## Nemotron Decoder Behavior (Hard-Won Context)

Lives in `larmindon-engine-nemotron`; these are Nemotron-specific workarounds,
not shared pipeline behavior:

- **Mid-speech reset**: If Nemotron produces ≥`empty_reset_threshold` (default: 6) consecutive empty chunks during VAD-detected speech, the decoder resets and replays buffered chunks to recover from stuck states. Configurable in Preferences.
- **Punctuation reset**: Decoder resets after `.`, `?`, `!` (excluding `...` and decimals) when enabled (default). Gives clean slate at sentence boundaries.
- **Pre-speech ring buffer** (shared, in core VAD): 500ms audio retained before speech onset for ASR context.

## PipeWire Notes (Linux)

- Use `object.serial` (not `global.id`) for device targeting
- Always set explicit format params (rate, channels, format) when creating capture streams
- Watcher thread auto-reconnects to app streams when they reappear (emits `source-switched`)

## Diagnostics

SQLite database at `larmindon_diag.sqlite` (project root). Tables:
- `sessions` — per-transcription session metadata (incl. `engine`; `chunk_size` is NULL for non-chunk engines)
- `events` — per-chunk `transcribe` rows (inference_ms, text preview) from the engine, per-drain `feed` rows (drain/vad/resample/iteration timing) from the loop
- `vad_events` — speech_start, speech_end (core), mid_speech_reset, punctuation_reset (nemotron)

See README.md for query examples.
