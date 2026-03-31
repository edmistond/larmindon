# PipeWire Implementation Notes

## Current State
Device enumeration via PipeWire is **working**. Audio capture implementation is **complete but NOT working** - stream connects but process callback never fires.

## Critical Finding
**qpwgraph observation**: larmindon stream appears but cannot be connected to anything. This suggests:
1. Stream is created successfully
2. Stream does NOT expose input ports (no audio format negotiation)
3. Process callback never fires because no audio is routed to the stream

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

### Audio Stream Implementation (NOT WORKING - 2026-03-30)

**Status**: Stream connects but process callback never fires. No audio captured.

#### Current Implementation

**Stream Setup**:
- Creates PipeWire Stream with `StreamBox::new()`
- Sets properties: `MEDIA_TYPE="Audio"`, `MEDIA_CATEGORY="Capture"`, `TARGET_OBJECT=<node_id>`
- Registers single listener with `state_changed` and `process` callbacks
- Connects with `Direction::Input` to target node
- Calls `stream.set_active(true)`
- Runs mainloop in dedicated thread

**Problem**: Process callback never invoked despite stream appearing in qpwgraph

**Root Cause Hypothesis**: 
Stream appears in graph but has no ports because:
1. No format parameters (SPA pods) passed to `stream.connect()`
2. Stream doesn't negotiate audio format with source
3. Source can't connect because stream doesn't advertise what format it accepts

#### Technical Details
- **API**: pipewire crate 0.9.x, libspa 0.9.x
- **Target**: Node ID passed as string to `TARGET_OBJECT` property
- **Direction**: `libspa::utils::Direction::Input` for capture
- **Threading**: MainLoop runs in dedicated thread spawned from `start()`
- **Current params**: Empty Vec passed to `stream.connect()`

#### Debugging Attempts

1. **State monitoring**: Added `state_changed` callback - **no output seen**
2. **Activation**: Added `stream.set_active(true)` - no change
3. **Process diagnostics**: Added call counter and sample logging - **never prints**
4. **Listener consolidation**: Combined state+process into single listener - **no change**
5. **Buffer checks**: Added check for `dequeue_buffer()` returning None - **never reached**

**Conclusion**: Process callback is never invoked, suggesting stream never reaches streaming state.

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
   - `[PipeWire] Starting stream for device: <id>`
   - `[PipeWire] Stream thread starting for node <id>`
   - `[PipeWire] Stream connected to node <id>`
   - `[PipeWire] Stream activated`
   - **NO state change messages**
   - **NO process callback output**
   - **No audio captured**
7. Stop transcription: clean shutdown messages appear

**qpwgraph**: Stream node visible but has no input ports, cannot be connected

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
- [ ] Audio capture produces f32 samples (NOT WORKING - no callback firing)
- [ ] Transcription works with PipeWire audio
- [ ] No crashes when devices connect/disconnect

## Implementation Log

### 2026-03-30: Phase 1 - Stream Setup Complete, But Not Working
- Implemented real audio capture in `start()` method
- Created `stream_thread_func()` with mainloop and stream
- Set up single listener with state_changed + process callbacks
- Stream connects and activates successfully
- **Problem**: Process callback never fires
- **qpwgraph**: Stream appears but has no input ports
- **Root cause**: Likely missing format parameters (SPA pods) for port negotiation

**Next Steps**: Need to add SPA format parameters to `stream.connect()` call to expose audio ports

## Potential Solutions to Try

### Option 1: Add SPA Format Parameters
Pass format description to `stream.connect()` to expose input ports:
```rust
// Need to create SPA pod describing desired format:
// - Format: F32
// - Channels: 1 (mono) or 2 (stereo)
// - Sample rate: 48000 (or negotiate)
// - Position: channel layout
```

### Option 2: Use Auto-Connect
Instead of targeting specific node, let PipeWire auto-connect:
```rust
stream.connect(Direction::Input, None, flags, params)
```

### Option 3: Check Node Port Availability
Verify target node actually has output ports before connecting.

### Option 4: Monitor Link State
Add param_changed callback to see if format negotiation happens.

