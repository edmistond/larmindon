# PipeWire Implementation Notes

## Current State
Device enumeration via PipeWire is **working**. Audio capture is **working** - process callback fires and audio samples are captured. Transcription produces output when connected to the correct source.

**Remaining issue**: Device targeting (`target.object`) may not route to the selected device automatically in all cases. Manual rewiring via qpwgraph confirms the pipeline works end-to-end once connected to the right source.

## Critical Finding (Resolved)
**qpwgraph observation**: larmindon stream previously appeared but could not be connected to anything.
**Root cause**: No SPA format params were passed to `stream.connect()`, so PipeWire couldn't negotiate audio format or create ports.
**Fix**: Build an `AudioInfoRaw` pod with `AudioFormat::F32LE` and pass it as an `EnumFormat` param. Also added `MAP_BUFFERS` and `RT_PROCESS` stream flags.

## Recent Fixes

### Init/Deinit Issue (Resolved)
The "Creation failed" error on second enumeration was caused by:
1. `test_pipewire_available()` in `lib.rs` called `pipewire::init()` then `pipewire::deinit()`
2. Subsequent `create_backend()` calls couldn't re-initialize PipeWire after deinit
3. **Fix**: Removed the `pipewire::deinit()` call - PipeWire stays initialized for the process lifetime

### Device Categorization (Resolved)
The registry listener wasn't collecting devices due to incorrect media class matching:
- **Wrong**: Looking for `Audio/Sink` with `APP_NAME` for applications
- **Correct**: Applications appear as `Stream/Output/Audio` nodes
- **Correct**: Inputs are `Audio/Source`, Monitors are `Audio/Sink`

## Architecture Implemented

### Audio Capture Abstraction
Created a backend abstraction in `src/audio_capture/mod.rs`:
- `AudioCapture` trait with `enumerate_devices()` and `start()` methods
- `AudioStream` trait for active streams
- `AudioDevice` struct with `DeviceType` enum (Application, Input, Monitor)

### PipeWire Backend
File: `src/audio_capture/pipewire.rs`

#### Device Enumeration (Working)
1. **Initialization**: `pipewire::init()` called once in `lib.rs` during `test_pipewire_available()`
2. **Thread**: Enumeration runs in spawned thread with 2s timeout
3. **MainLoop**: Creates `MainLoopBox`, `ContextBox`, connects to core, gets registry
4. **Registry Listener**: Captures node events, categorizes by media class
5. **Timer-Based Exit**: Raw pointer to MainLoopBox allows timer callback to call `quit()` after 600ms

### Audio Stream Implementation (WORKING - 2026-03-30)

**Status**: Stream connects, process callback fires, audio samples are captured and transcribed.

#### Current Implementation

**Stream Setup**:
- Creates PipeWire Stream with `StreamBox::new()`
- Sets properties: `MEDIA_TYPE="Audio"`, `MEDIA_CATEGORY="Capture"`, `MEDIA_ROLE="Music"`, `target.object=<node_id>`
- For Monitor (Audio/Sink) devices, also sets `stream.capture.sink=true`
- Registers single listener with `state_changed`, `param_changed`, and `process` callbacks
- Connects with `Direction::Input`, `None` for target_id (routing handled by `target.object` property)
- Stream flags: `AUTOCONNECT | MAP_BUFFERS | RT_PROCESS`
- Runs mainloop in dedicated thread

#### What Fixed It
1. **SPA format params**: Built `AudioInfoRaw` pod with `AudioFormat::F32LE`, serialized as `EnumFormat` param, passed to `stream.connect()`. Without this, PipeWire couldn't create ports or negotiate format.
2. **Stream flags**: Added `MAP_BUFFERS` (makes buffer data accessible in process callback) and `RT_PROCESS` (invokes process callback in realtime thread).
3. **Device type awareness**: Backend caches enumerated devices. `stream_thread_func` receives `DeviceType` and sets `stream.capture.sink=true` for Monitor devices.
4. **Connect target**: Changed from `Some(target_node_id)` to `None` in `stream.connect()` — `target.object` property handles routing.

#### Technical Details
- **API**: pipewire crate 0.9.x, libspa 0.9.x
- **Target**: Node ID passed as string to `target.object` property
- **Direction**: `libspa::utils::Direction::Input` for capture
- **Threading**: MainLoop runs in dedicated thread spawned from `start()`
- **Format params**: `AudioInfoRaw` with F32LE, rate/channels left unset for native negotiation

## API Compatibility Issues Found

### PipeWire Crate Version 0.9.x
1. **APPLICATION_NAME**: Not in `keys` module - use literal string `"application.name"`
2. **TARGET_OBJECT**: Not found in keys module - use literal string `"target.object"`
3. **Direction**: At `libspa::utils::Direction::Input` (NOT `libspa::Direction`)
4. **Multiple listeners**: Cannot register separate listeners - must chain callbacks in single listener

## System Setup

### Dependencies Installed
- `pipewire` - PipeWire server
- `pipewire-audio` - Audio support
- `libpipewire` - Libraries
- `clang` - For bindgen

### Runtime Environment
- PipeWire is running (`pipewire` service active)
- Environment variable `LARMINDON_AUDIO_BACKEND=pipewire` selects backend
- Fallback to CPAL works when PipeWire unavailable

## Key Files

- `src/audio_capture/mod.rs` - Abstraction layer
- `src/audio_capture/pipewire.rs` - PipeWire backend (enumeration working, capture broken)
- `src/audio_capture/cpal.rs` - CPAL backend (fully working)
- `src/lib.rs` - Backend selection logic, PipeWire init
- `Cargo.toml` - Features: `pipewire`, `cpal`

## Current Behavior

1. App starts with "Attempting to use PipeWire backend..."
2. "PipeWire is available, using PipeWire backend" appears
3. "[PipeWire] Enumerating devices..." appears
4. "[PipeWire] Found N devices" appears with applications, inputs, and monitors
5. Device list in UI shows all categories
6. Select device, start transcription:
   - `[PipeWire] Starting stream for device: <id> (type: <type>)`
   - `[PipeWire] Stream thread starting for node <id> (type: <type>)`
   - `[PipeWire] Stream connected, targeting node <id>`
   - State change messages appear (Unconnected -> Connecting -> Paused -> Streaming)
   - `[PipeWire] Captured N samples in last second` appears
   - Transcription output generated
7. Stop transcription: clean shutdown messages appear

**qpwgraph**: Stream node visible with input ports. Can be manually rewired to different sources.

**Known issue**: `target.object` may not always route to the selected device. Manual rewiring in qpwgraph confirms full pipeline works.

## Build Commands

```bash
# Build with both backends
cd app && npm run tauri dev

# Force CPAL
LARMINDON_AUDIO_BACKEND=cpal npm run tauri dev

# Force PipeWire
LARMINDON_AUDIO_BACKEND=pipewire npm run tauri dev
```

## Known Working Alternative

**CPAL backend works perfectly** - use as fallback while debugging PipeWire:
```bash
LARMINDON_AUDIO_BACKEND=cpal npm run tauri dev
```

## PipeWire Resources

- Crate: https://crates.io/crates/pipewire (0.9.x)
- Docs: https://pipewire.pages.freedesktop.org/pipewire-rs/
- Keys: https://pipewire.pages.freedesktop.org/pipewire-rs/pipewire/keys/index.html
- Examples: Sparse, check pipewire-rs git repo examples/

## Success Criteria

- [x] Device enumeration shows applications (Brave, Firefox, etc.)
- [x] Can see output monitors in device list
- [x] Can see input devices in device list
- [x] Audio capture produces f32 samples
- [x] Transcription works with PipeWire audio (confirmed via qpwgraph rewire to Brave)
- [ ] target.object routing connects to correct device automatically
- [ ] No crashes when devices connect/disconnect

## Implementation Log

### 2026-03-30: Phase 1 - Stream Setup Complete, But Not Working
- Implemented real audio capture in `start()` method
- Created `stream_thread_func()` with mainloop and stream
- Set up single listener with state_changed + process callbacks
- Stream connects and activates successfully
- **Problem**: Process callback never fires
- **qpwgraph**: Stream appears but has no input ports
- **Root cause**: Missing format parameters (SPA pods) for port negotiation

### 2026-03-30: Phase 2 - Audio Capture Working
- Added SPA format pod (`AudioInfoRaw` with `AudioFormat::F32LE`) to `stream.connect()` params
- Added `MAP_BUFFERS | RT_PROCESS` stream flags
- Added `MEDIA_ROLE => "Music"` property
- Changed `connect()` target_id from `Some(node_id)` to `None`, relying on `target.object` property
- Added device type awareness: backend caches devices, passes `DeviceType` to stream thread
- Added `stream.capture.sink=true` property for Monitor devices
- **Result**: Process callback fires, audio captured, transcription works when manually wired to correct source
- **Remaining**: `target.object` routing doesn't always connect to selected device

## Potential Solutions for target.object Routing

### Investigate target.object behavior
- Check if `target.object` expects node name/serial instead of node ID
- Try `node.target` property as alternative  
- Check WirePlumber session manager logs for routing decisions
- Verify node IDs are stable between enumeration and stream creation

