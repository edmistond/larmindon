# PipeWire Implementation Notes

## Current State
Device enumeration via PipeWire is **working**. Audio capture implementation is **complete and ready for testing**.

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
4. **Registry Listener**: Captures node events, categorizes by media class:
   - `Stream/Output/Audio` → Applications (apps actively playing audio)
   - `Audio/Source` → Input devices (microphones)
   - `Audio/Sink` → Monitors (output devices - can capture all audio going to them)
5. **Timer-Based Exit**: Raw pointer to MainLoopBox allows timer callback to call `quit()` after 600ms

### Audio Stream Implementation (Complete - 2026-03-30)

**Status**: Audio capture implementation is complete and compiles successfully. Ready for testing.

#### Implementation Details

**Stream Setup** (Completed):
- [x] Create PipeWire Stream in `start()` method
  - Use `pipewire::stream::StreamBox::new()` with core reference
  - Set properties: `MEDIA_TYPE="Audio"`, `MEDIA_CATEGORY="Capture"`, `TARGET_OBJECT=<node_id>`
  - Connect with `Direction::Input`
- [x] Set up process callback using `stream.add_local_listener().process().register()`
  - Call `stream.dequeue_buffer()` to get audio buffers
  - Extract samples and convert to f32
  - Downmix to mono
  - Push into shared `Arc<Mutex<VecDeque<f32>>>`
- [x] Run MainLoop in dedicated thread
  - Create MainLoopBox, ContextBox, connect to core
  - Spawn thread that runs `mainloop.run()`
  - Use stop_flag and shutdown channel to coordinate shutdown

**Format Handling** (Implemented):
- Supports f32 audio format
- Handles mono and stereo audio (downmixes stereo to mono)
- Sample rate is determined by the source device (resampling handled by audio_engine)

**Shutdown** (Implemented):
- `PipewireStream.stop()` signals thread to quit via stop_flag and shutdown channel
- MainLoop timer checks stop_flag every 10ms and calls `quit()` when set
- Thread joins cleanly and resources are dropped

#### Technical Details
- **API**: pipewire crate 0.9.x, libspa 0.9.x
- **Target**: Node ID passed as string to `TARGET_OBJECT` property
- **Direction**: `libspa::utils::Direction::Input` for capture (note: `utils` submodule required)
- **Threading**: MainLoop runs in dedicated thread spawned from `start()`
- **Buffer Access**: Uses `Buffer::datas_mut()` to get data chunks, `Data::chunk()` for metadata, `Data::data()` for sample bytes
- **Format**: Currently assumes f32 format (4 bytes per sample)
  - Mono: stride=4 bytes, copies directly
  - Stereo: stride=8 bytes, downmixes to mono by averaging channels

#### Key Code Locations
- `start()` method at line 33 in `pipewire.rs`
- `stream_thread_func()` at line 101 - main capture thread
- Process callback at line 131-204 handles audio buffer processing
- Shutdown coordination at line 213-231

## API Compatibility Issues Found

### PipeWire Crate Version 0.9.x
1. **APPLICATION_NAME**: Not in `keys` module - use literal string `"application.name"`
2. **TARGET_OBJECT**: Not found in keys module - use literal string `"target.object"`
3. **Direction**: At `libspa::utils::Direction::Input` (NOT `libspa::Direction`)
4. **Buffer Access**: 
   - `Buffer::datas_mut()` returns `&mut [Data]` 
   - `Data::chunk()` returns chunk metadata (offset, size, stride)
   - `Data::data()` returns `Option<&mut [u8]>` for raw bytes
   - Must get chunk info BEFORE calling `data()` (borrow checker)

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
- `src/audio_capture/pipewire.rs` - PipeWire backend (enumeration + capture complete)
- `src/audio_capture/cpal.rs` - CPAL backend (fully working)
- `src/lib.rs` - Backend selection logic, PipeWire init
- `Cargo.toml` - Features: `pipewire`, `cpal`

## Current Behavior

1. App starts with "Attempting to use PipeWire backend..."
2. "PipeWire is available, using PipeWire backend" appears
3. "[PipeWire] Enumerating devices..." appears
4. "[PipeWire] Found N devices" appears with applications, inputs, and monitors
5. Device list in UI shows all categories
6. **NEW**: Selecting device and starting transcription creates real PipeWire stream
7. **NEW**: Audio should flow through to transcription engine

## Build Commands

```bash
# Build with both backends
cd app && npm run tauri dev

# Force CPAL
LARMINDON_AUDIO_BACKEND=cpal npm run tauri dev

# Force PipeWire
LARMINDON_AUDIO_BACKEND=pipewire npm run tauri dev
```

## Testing Protocol

**Ready for testing!**

To test:
1. Start the app: `cd app && npm run tauri dev &`
2. Check console for PipeWire messages
3. Select a device (application, input, or monitor)
4. Start transcription
5. Look for:
   - "[PipeWire] Starting stream for device: <id>"
   - "[PipeWire] Stream connected to node <id>"
   - Audio flowing (transcription appearing)
6. Stop transcription and verify clean shutdown:
   - "[PipeWire] Stopping stream..."
   - "[PipeWire] Stream thread joined"
   - "[PipeWire] Stream stopped"

**Expected behavior**: App enumerates devices, connects to selected node, captures audio in f32 format, downmixes to mono, and feeds to transcription engine.

**Potential issues to watch for**:
- Format negotiation (if source isn't f32)
- Buffer underruns/overruns
- Thread cleanup on rapid start/stop
- Sample rate mismatches (should be handled by resampler in audio_engine)

## PipeWire Resources

- Crate: https://crates.io/crates/pipewire (0.9.x)
- Docs: https://pipewire.pages.freedesktop.org/pipewire-rs/
- Keys: https://pipewire.pages.freedesktop.org/pipewire-rs/pipewire/keys/index.html
- Examples: Sparse, check pipewire-rs git repo examples/

## Success Criteria

- [x] Device enumeration shows applications (Brave, Firefox, etc.)
- [x] Can see output monitors in device list
- [x] Can see input devices in device list
- [x] Audio capture produces f32 samples (implementation complete)
- [ ] Transcription works with PipeWire audio (needs testing)
- [ ] No crashes when devices connect/disconnect (needs testing)

## Implementation Log

### 2026-03-30: Phase 1 - Stream Setup Complete
- Implemented real audio capture in `start()` method
- Created `stream_thread_func()` that runs PipeWire mainloop in dedicated thread
- Set up process callback using `stream.add_local_listener().process()`
- Implemented f32 audio extraction from PipeWire buffers
- Added mono/stereo downmixing logic
- Implemented clean shutdown with stop_flag and shutdown channel
- Fixed borrow checker issues (get chunk info before data)
- Fixed Direction import (`libspa::utils::Direction` not `libspa::Direction`)
- Compilation successful with only unrelated warnings

**Next**: Testing with real audio to verify transcription works

