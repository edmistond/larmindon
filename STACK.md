# Tech Stack

## GUI

- **Tauri** — desktop application framework

## Audio

- **CPAL** — cross-platform audio I/O
- **Rubato** — sample rate conversion
- **pipewire** — PipeWire integration (Linux) - https://crates.io/crates/pipewire

## Transcription

- **parakeet-rs** — speech-to-text
- **VAD** — based on silero-vad: voice activity detection (via ONNX Runtime / `ort` + `ndarray`)
