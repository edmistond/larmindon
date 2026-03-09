# Larmindon

A real-time captioning desktop app built with Tauri, React, and [parakeet-rs](https://github.com/altunenes/parakeet-rs) (NVIDIA Nemotron streaming ASR).

> **Warning:** This project is early-stage and under active development. Expect rough edges.

![Larmindon screenshot](larmindon.png)

## How it works

Larmindon captures audio from an input device, resamples it to 16kHz, and feeds it to the Nemotron streaming speech recognition model. Transcribed text appears in real time in a scrolling text area.

The audio pipeline runs on a dedicated OS thread, communicating with the Tauri frontend via channels and events. This architecture is designed to accommodate future PipeWire integration on Linux.

## Prerequisites

- [Nemotron streaming model files](https://huggingface.co/altunenes/parakeet-rs/tree/main/nemotron-speech-streaming-en-0.6b) downloaded locally
- Node.js and npm
- Rust toolchain
- Tauri v2 prerequisites ([see Tauri docs](https://v2.tauri.app/start/prerequisites/))

## Building & Running

```sh
cd app
npm install
npm run tauri dev
```

For a release build:

```sh
npm run tauri build
```

### Hardware acceleration

Theoretically, optional Cargo features can be enabled for GPU-accelerated inference:

```sh
# macOS - CoreML
npm run tauri dev -- -- --features coreml

# Windows - DirectML
npm run tauri dev -- -- --features directml
```

However, I've not seen it actually using the GPU in practice, unfortunately.

## Platform notes

### macOS

macOS does not natively provide audio loopback devices. To capture system audio (e.g. from a browser or media player), you need third-party software such as [BlackHole](https://existential.audio/blackhole/) or [Loopback](https://rogueamoeba.com/loopback/) to create a virtual audio input device. Select the loopback device from the dropdown in Larmindon.

### Linux & Windows

Not yet tested. Linux support will eventually use PipeWire for audio capture. Windows WASAPI loopback support is present in the underlying CPAL code but has not been verified.

## Tech Stack

See [STACK.md](STACK.md) for the full list of technologies used.
