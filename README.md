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

### Chunk size

Nemotron supports chunk sizes of 80ms, 160ms, 560ms, and 1120ms. The default is 560ms. Smaller chunks give lower latency; larger chunks provide more context per inference call but may struggle to keep up in real time. Set the `CHUNK_MS` environment variable to experiment:

```sh
CHUNK_MS=160 npm run tauri dev
```

## Platform notes

### macOS

macOS does not natively provide audio loopback devices. To capture system audio (e.g. from a browser or media player), you need third-party software such as [BlackHole](https://existential.audio/blackhole/) or [Loopback](https://rogueamoeba.com/loopback/) to create a virtual audio input device. Select the loopback device from the dropdown in Larmindon.

### Linux & Windows

Not yet tested. Linux support will eventually use PipeWire for audio capture. Windows WASAPI loopback support is present in the underlying CPAL code but has not been verified.

## Debugging / Diagnostics

Larmindon writes diagnostic data to a SQLite database at `larmindon_diag.sqlite` in the project root. Each transcription session creates rows in `sessions`, `events`, and `vad_events` tables. Use these queries to investigate behavior:

### VAD queries

**Speech segment timeline:**
```sql
SELECT s.uptime_ms AS start_ms, e.uptime_ms AS end_ms,
       e.speech_duration_ms, s.pre_speech_samples
FROM vad_events s
JOIN vad_events e ON e.session_id = s.session_id
  AND e.event_type = 'speech_end'
  AND e.uptime_ms = (
    SELECT MIN(uptime_ms) FROM vad_events
    WHERE session_id = s.session_id AND event_type = 'speech_end' AND uptime_ms > s.uptime_ms
  )
WHERE s.event_type = 'speech_start'
  AND s.session_id = (SELECT MAX(id) FROM sessions)
ORDER BY s.uptime_ms;
```

**VAD trigger rate (segments per minute):**
```sql
SELECT COUNT(*) * 60000.0 / (MAX(uptime_ms) - MIN(uptime_ms)) AS segments_per_min
FROM vad_events
WHERE event_type = 'speech_start'
  AND session_id = (SELECT MAX(id) FROM sessions);
```

**Mid-speech resets:**
```sql
SELECT * FROM vad_events
WHERE event_type = 'mid_speech_reset'
  AND session_id = (SELECT MAX(id) FROM sessions)
ORDER BY uptime_ms;
```

### Inference queries

**Empty result streaks (longest runs of empty transcriptions):**
```sql
WITH runs AS (
  SELECT id, chunk_num, text_empty, vad_state,
         SUM(CASE WHEN text_empty = 0 THEN 1 ELSE 0 END) OVER (ORDER BY chunk_num) AS grp
  FROM events
  WHERE event_type = 'transcribe'
    AND session_id = (SELECT MAX(id) FROM sessions)
)
SELECT MIN(chunk_num) AS start_chunk, MAX(chunk_num) AS end_chunk,
       COUNT(*) AS run_length, vad_state
FROM runs WHERE text_empty = 1
GROUP BY grp HAVING COUNT(*) >= 5
ORDER BY run_length DESC LIMIT 20;
```

**Inference timing:**
```sql
SELECT COUNT(*) AS total,
       ROUND(AVG(inference_ms), 1) AS avg_ms,
       MAX(inference_ms) AS max_ms,
       ROUND(SUM(text_empty) * 100.0 / COUNT(*), 1) AS empty_pct
FROM events
WHERE event_type = 'transcribe'
  AND session_id = (SELECT MAX(id) FROM sessions);
```

**Session overview:**
```sql
SELECT s.id, s.started_at, s.chunk_size,
       COUNT(e.id) AS total_chunks,
       SUM(e.text_empty) AS empty_chunks,
       ROUND(100.0 * SUM(e.text_empty) / COUNT(e.id), 1) AS empty_pct
FROM sessions s
JOIN events e ON e.session_id = s.id AND e.event_type = 'transcribe'
GROUP BY s.id ORDER BY s.id DESC;
```

### Combined queries

**VAD vs ASR alignment (what % of speech-state chunks produce text):**
```sql
SELECT vad_state,
       COUNT(*) AS total,
       SUM(CASE WHEN text_empty = 0 THEN 1 ELSE 0 END) AS with_text,
       ROUND(100.0 * SUM(CASE WHEN text_empty = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS text_pct
FROM events
WHERE event_type = 'transcribe'
  AND session_id = (SELECT MAX(id) FROM sessions)
GROUP BY vad_state;
```

**Gap analysis (gaps > 5s between non-empty transcriptions):**
```sql
SELECT chunk_num, uptime_ms, text_preview, vad_state,
       uptime_ms - LAG(uptime_ms) OVER (ORDER BY chunk_num) AS gap_ms
FROM events
WHERE event_type = 'transcribe' AND text_empty = 0
  AND session_id = (SELECT MAX(id) FROM sessions)
HAVING gap_ms > 5000
ORDER BY gap_ms DESC;
```

## Tech Stack

See [STACK.md](STACK.md) for the full list of technologies used.
