# PipeWire Implementation Notes

## Current State
Device enumeration via PipeWire is not working. The code compiles successfully but no devices are returned.

## Architecture Implemented

### Audio Capture Abstraction
Created a backend abstraction in `src/audio_capture/mod.rs`:
- `AudioCapture` trait with `enumerate_devices()` and `start()` methods
- `AudioStream` trait for active streams
- `AudioDevice` struct with `DeviceType` enum (Application, Input, Monitor)

### PipeWire Backend
File: `src/audio_capture/pipewire.rs`

#### Device Enumeration Attempt
1. **Initialization**: Uses `pipewire::init()` and creates `MainLoopBox`
2. **Context Setup**: Creates `ContextBox`, connects to core, gets registry
3. **Registry Listener**: Adds global listener to capture node events
4. **Device Categorization**:
   - Apps: `Audio/Sink` with `APP_NAME`
   - Monitors: Virtual `Audio/Sink`
   - Inputs: `Audio/Source`
5. **Timer-Based Exit**: Uses raw pointer to `MainLoopBox` stored as `usize` to allow timer callback to call `quit()` after 600ms

#### Current Implementation Issues

##### Issue 1: No Devices Collected
The registry listener callback never fires during the mainloop run. Possible causes:
- Timer exits too quickly (600ms) before registry populates
- Need to use `sync` call to ensure registry is populated
- MainLoopBox threading issues - the raw pointer approach may be unsafe

##### Issue 2: MainLoop Threading
PipeWire's `MainLoopBox` is `!Send`, meaning:
- Cannot be moved to another thread
- Cannot call `run()` in a spawned thread easily
- Current workaround uses raw pointer in timer callback (unsafe)

##### Issue 3: Device ID Format
Node IDs are returned as strings from `global.id.to_string()`. Need to verify this is the correct format to pass to `TARGET_OBJECT` key when creating streams.

### Audio Stream Implementation (Incomplete)

The `start()` method currently returns a dummy stream since full implementation has API issues:

1. **Stream Creation**: `StreamBox::new()` requires:
   - Core reference
   - Stream name
   - Properties (including `TARGET_OBJECT` for target node)

2. **Properties**: Need to use `properties!` macro with:
   - `MEDIA_TYPE => "Audio"`
   - `MEDIA_CATEGORY => "Capture"`
   - `TARGET_OBJECT => device_id`

3. **Direction**: Uses `pipewire::Direction::Input` for capture

4. **Process Callback**: Should call `stream.dequeue_buffer()` and process audio data

5. **MainLoop Challenge**: 
   - Stream needs mainloop to run for audio processing
   - Must coordinate with stop flag
   - Cannot easily share MainLoopBox across threads

## API Compatibility Issues Found

### PipeWire Crate Version 0.9.2
Several API mismatches encountered:

1. **TARGET_OBJECT**: Not found in keys module - may be named differently or require different import
2. **Direction**: Not directly in `pipewire` namespace - need to find correct path
3. **Buffer Access**: `Buffer::datas()` method API unclear
4. **Channel**: `pipewire::channel` module exists but usage pattern unclear

### Documentation Gaps
- Unclear how to properly signal mainloop quit from timer
- Unclear device ID format for stream targeting
- Unclear buffer format negotiation

## What We Tried

### Approach 1: Simple Timeout
- Add timer that sets flag after 500ms
- Run mainloop
- Collect devices after timer fires
- **Result**: Devices not collected, flag approach doesn't help quit mainloop

### Approach 2: Raw Pointer Workaround
- Store `&mainloop as *const MainLoopBox as usize`
- Timer callback casts back and calls `quit()`
- **Result**: Compiles, runs, but no devices collected

### Approach 3: Threaded MainLoop
- Try to spawn mainloop.run() in separate thread
- **Result**: Compile error - MainLoopBox is !Send

### Approach 4: Async Channel
- Try to use pipewire::channel for coordination
- **Result**: API unclear, couldn't get working

## System Setup

### Dependencies Installed (Arch)
- `pipewire` - PipeWire server
- `pipewire-audio` - Audio support
- `libpipewire` - Libraries
- `clang` - For bindgen

### Runtime Environment
- PipeWire is running (`pipewire` service active)
- Environment variable `LARMINDON_AUDIO_BACKEND=pipewire` selects backend
- Fallback to CPAL works when PipeWire unavailable

## Next Steps to Try

### 1. Registry Sync
After getting registry, call `core.sync()` to ensure all globals are enumerated before starting mainloop.

### 2. Longer Timeout
Increase timer from 600ms to 2000ms to allow registry to fully populate.

### 3. Proper Device ID Format
Research correct format for TARGET_OBJECT - may need "pipewire:" prefix or different key entirely.

### 4. Stream Implementation
Focus on getting stream connected and processing buffers before worrying about mainloop coordination.

### 5. Test Tools
Use `pw-dump` or `pw-cli` to verify PipeWire is working and see actual node IDs.

## Working Code to Build Upon

### Audio Capture Module Structure
```rust
// audio_capture/mod.rs - Trait definitions work correctly
pub trait AudioCapture: Send {
    fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, Box<dyn Error>>;
    fn start(&self, device_id: Option<String>, buffer: Arc<Mutex<VecDeque<f32>>>, stop_flag: Arc<AtomicBool>) -> Result<Box<dyn AudioStream>, Box<dyn Error>>;
}
```

### CPAL Backend
Works correctly - can use as reference for:
- Thread spawning pattern
- Buffer sharing with processing thread
- Device ID handling

### Backend Selection
Lib.rs correctly:
- Checks LARMINDON_AUDIO_BACKEND env var
- Tests PipeWire availability
- Falls back to CPAL
- Panics if neither available

## Key Files

- `src/audio_capture/mod.rs` - Abstraction layer
- `src/audio_capture/pipewire.rs` - PipeWire backend (enumeration stub)
- `src/audio_capture/cpal.rs` - CPAL backend (fully working)
- `src/lib.rs` - Backend selection logic
- `Cargo.toml` - Features: `pipewire`, `cpal`

## Current Behavior

1. App starts with "Attempting to use PipeWire backend..."
2. "PipeWire is available, using PipeWire backend" appears
3. "[PipeWire] Enumerating devices..." appears
4. "[PipeWire] Found 0 devices" appears (or times out)
5. Device list in UI is empty
6. Cannot start transcription

## CPAL Fallback
When PipeWire fails, CPAL works correctly:
- Lists input devices
- Can capture and transcribe audio
- Works on Linux via ALSA/PulseAudio

## Build Commands

```bash
# Build with both backends
cargo build

# Force CPAL
LARMINDON_AUDIO_BACKEND=cpal cargo run

# Force PipeWire (current broken state)
LARMINDON_AUDIO_BACKEND=pipewire cargo run
```

## PipeWire Resources

- Crate: https://crates.io/crates/pipewire (0.9.2)
- Docs: https://pipewire.pages.freedesktop.org/pipewire-rs/
- Keys: https://pipewire.pages.freedesktop.org/pipewire-rs/pipewire/keys/index.html
- Examples: Sparse, need to check pipewire-rs git repo

## Open Questions

1. Why does the registry listener never fire?
2. What's the correct key for target node (TARGET_OBJECT vs NODE_TARGET)?
3. How to safely coordinate mainloop quit with device collection?
4. How to properly handle buffer format negotiation?
5. How to share audio data between PipeWire thread and processing thread?

## Success Criteria

- [ ] Device enumeration shows applications (Firefox, Zoom, etc.)
- [ ] Can select "Monitor of Built-in Audio" as input
- [ ] Audio capture produces f32 samples at device rate
- [ ] Transcription works with PipeWire audio
- [ ] No crashes when devices connect/disconnect
