# PipeWire Implementation Notes

## Current State
Device enumeration and audio capture via PipeWire are **fully working**. Transcription works for all device types: application streams (e.g. Brave), sink monitors (system audio), and input devices (microphones).

## Architecture

### Audio Capture Abstraction
`src/audio_capture/mod.rs`:
- `AudioCapture` trait with `enumerate_devices()` and `start()` methods
- `AudioStream` trait for active streams
- `AudioDevice` struct with `DeviceType` enum (Application, Input, Monitor)

### PipeWire Backend
`src/audio_capture/pipewire.rs`:

**Device Enumeration**:
1. `pipewire::init()` called once in `lib.rs` during `test_pipewire_available()`
2. Enumeration runs in spawned thread with 2s timeout
3. Registry listener categorizes nodes by `media.class`:
   - `Stream/Output/Audio` → Application (per-app capture)
   - `Audio/Source` → Input (microphones)
   - `Audio/Sink` → Monitor (system audio out)
4. Device IDs use `object.serial` from node properties (not registry `global.id`)

**Audio Stream**:
- Stream properties: `MEDIA_TYPE="Audio"`, `MEDIA_CATEGORY="Capture"`, `MEDIA_ROLE="Music"`, `target.object=<serial>`
- For Monitor devices, also sets `stream.capture.sink=true`
- SPA format pod: `AudioInfoRaw` with `AudioFormat::F32LE`, rate/channels left unset for native negotiation
- Stream flags: `AUTOCONNECT | MAP_BUFFERS | RT_PROCESS`
- Connects with `Direction::Input`, `None` for target_id (routing handled by `target.object` property)
- Mainloop runs in dedicated thread with 10ms timer for stop-flag polling

## Issues Resolved

### No audio capture / process callback never fires
**Root cause**: No SPA format params passed to `stream.connect()`, so PipeWire couldn't negotiate format or create ports.
**Fix**: Build `AudioInfoRaw` pod with `AudioFormat::F32LE`, serialize as `EnumFormat` param. Also added `MAP_BUFFERS` and `RT_PROCESS` stream flags.

### App targeting connected to wrong device (e.g. mic instead of Brave)
**Root cause**: Device IDs used registry `global.id`, but `target.object` matches against `object.serial`. These differ for app streams (e.g. Brave had global.id=114 but object.serial=404 — serial 114 was the mic).
**Fix**: Enumeration now reads `object.serial` from node properties instead of using `global.id`.

### Init/deinit crash on second enumeration
**Root cause**: `test_pipewire_available()` called `pipewire::deinit()`, preventing re-initialization.
**Fix**: Removed `pipewire::deinit()` — PipeWire stays initialized for process lifetime.

## API Notes (pipewire crate 0.9.x)

- `APPLICATION_NAME` not in `keys` module — use literal `"application.name"`
- `TARGET_OBJECT` not in `keys` module — use literal `"target.object"`
- `Direction` at `libspa::utils::Direction::Input`
- Cannot register separate listeners — must chain callbacks in single listener

## Build Commands

```bash
cd app && npm run tauri dev                          # default (both backends)
LARMINDON_AUDIO_BACKEND=pipewire npm run tauri dev   # force PipeWire
LARMINDON_AUDIO_BACKEND=cpal npm run tauri dev       # force CPAL (fallback)
```

## Key Files

- `src/audio_capture/mod.rs` — Abstraction layer
- `src/audio_capture/pipewire.rs` — PipeWire backend
- `src/audio_capture/cpal.rs` — CPAL backend (fallback)
- `src/lib.rs` — Backend selection logic, PipeWire init

## Remaining Work

- [ ] Handle device connect/disconnect gracefully
