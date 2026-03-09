use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use parakeet_rs::Nemotron;
use rubato::{FftFixedIn, Resampler};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::audio_config;

const MODEL_PATH: &str = "/Users/edmistond/Downloads/prs-nemotron";
const ASR_SAMPLE_RATE: usize = 16000;
const DEFAULT_CHUNK_MS: usize = 560;

/// Convert a chunk duration in milliseconds to samples at 16kHz.
/// Valid Nemotron chunk sizes: 80, 160, 560, 1120 ms.
pub fn chunk_ms_to_samples(ms: usize) -> usize {
    ASR_SAMPLE_RATE * ms / 1000
}

pub fn parse_chunk_ms() -> usize {
    const VALID: &[usize] = &[80, 160, 560, 1120];
    match std::env::var("CHUNK_MS") {
        Ok(val) => match val.parse::<usize>() {
            Ok(ms) if VALID.contains(&ms) => {
                println!("Using CHUNK_MS={ms}ms from environment");
                ms
            }
            Ok(ms) => {
                eprintln!(
                    "Invalid CHUNK_MS={ms}; must be one of {:?}. Falling back to {DEFAULT_CHUNK_MS}ms.",
                    VALID
                );
                DEFAULT_CHUNK_MS
            }
            Err(_) => {
                eprintln!(
                    "Could not parse CHUNK_MS={val:?}. Falling back to {DEFAULT_CHUNK_MS}ms."
                );
                DEFAULT_CHUNK_MS
            }
        },
        Err(_) => DEFAULT_CHUNK_MS,
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct TranscriptionPayload {
    pub text: String,
}

pub enum Command {
    ListDevices {
        reply: mpsc::Sender<Vec<AudioDevice>>,
    },
    Start {
        device_id: Option<String>,
    },
    Stop,
    Shutdown,
}

pub struct AudioEngine {
    app_handle: AppHandle,
    cmd_rx: mpsc::Receiver<Command>,
    chunk_size: usize,
    // Active session state
    stream: Option<Stream>,
    processing_thread: Option<JoinHandle<()>>,
    stop_flag: Option<Arc<AtomicBool>>,
}

impl AudioEngine {
    pub fn new(app_handle: AppHandle, cmd_rx: mpsc::Receiver<Command>, chunk_size: usize) -> Self {
        Self {
            app_handle,
            cmd_rx,
            chunk_size,
            stream: None,
            processing_thread: None,
            stop_flag: None,
        }
    }

    pub fn run(mut self) {
        loop {
            let cmd = match self.cmd_rx.recv() {
                Ok(cmd) => cmd,
                Err(_) => break, // Channel closed
            };

            match cmd {
                Command::ListDevices { reply } => {
                    let devices = Self::enumerate_devices();
                    let _ = reply.send(devices);
                }
                Command::Start { device_id } => {
                    self.stop_active_session();
                    if let Err(e) = self.start_session(device_id) {
                        eprintln!("Failed to start transcription: {}", e);
                        let _ = self.app_handle.emit(
                            "transcription-error",
                            TranscriptionPayload {
                                text: format!("Error: {}", e),
                            },
                        );
                    }
                }
                Command::Stop => {
                    self.stop_active_session();
                }
                Command::Shutdown => {
                    self.stop_active_session();
                    break;
                }
            }
        }
    }

    fn enumerate_devices() -> Vec<AudioDevice> {
        let host = cpal::default_host();
        let mut devices = Vec::new();

        if let Ok(input_devices) = host.input_devices() {
            for device in input_devices {
                let name = device
                    .description()
                    .map(|desc| desc.name().to_string())
                    .unwrap_or_else(|_| "<unknown>".to_string());
                let id = device
                    .id()
                    .map(|id| id.to_string())
                    .unwrap_or_default();
                if !id.is_empty() {
                    devices.push(AudioDevice { id, name });
                }
            }
        }

        devices
    }

    fn start_session(
        &mut self,
        device_id: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let host = cpal::default_host();

        let device = if let Some(ref id) = device_id {
            host.input_devices()?
                .find(|d| {
                    d.id()
                        .map(|did| did.to_string() == *id)
                        .unwrap_or(false)
                })
                .ok_or_else(|| format!("No device found with ID: {}", id))?
        } else {
            host.default_input_device()
                .ok_or("No default input device found")?
        };

        let device_name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "<unknown>".to_string());
        println!("Using device: {}", device_name);

        let (supported_config, sample_format) = audio_config::select_input_config(&device)?;
        let config: StreamConfig = supported_config.into();
        let input_rate = u32::from(config.sample_rate) as usize;
        let channels = config.channels as usize;
        let needs_resample = input_rate != ASR_SAMPLE_RATE;

        println!(
            "Audio config: {} channels, {} Hz, {:?} (resample: {})",
            channels, input_rate, sample_format, needs_resample
        );

        let buffer: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
        let buffer_for_callback = Arc::clone(&buffer);

        let stream =
            Self::build_stream(&device, &config, sample_format, channels, buffer_for_callback)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_thread = Arc::clone(&stop_flag);
        let app_handle = self.app_handle.clone();
        let chunk_size = self.chunk_size;

        let processing_thread = thread::spawn(move || {
            println!("[diag] Processing thread started");
            match Self::processing_loop(app_handle, buffer, stop_flag_thread, input_rate, needs_resample, chunk_size)
            {
                Ok(()) => println!("[diag] Processing loop exited normally"),
                Err(e) => eprintln!("[diag] Processing loop CRASHED: {}", e),
            }
        });

        stream.play()?;

        self.stream = Some(stream);
        self.processing_thread = Some(processing_thread);
        self.stop_flag = Some(stop_flag);

        Ok(())
    }

    fn stop_active_session(&mut self) {
        if let Some(flag) = self.stop_flag.take() {
            flag.store(true, Ordering::Relaxed);
        }
        // Drop the stream to stop audio capture
        self.stream.take();
        if let Some(handle) = self.processing_thread.take() {
            match handle.join() {
                Ok(()) => println!("[diag] Processing thread joined cleanly"),
                Err(e) => eprintln!("[diag] Processing thread PANICKED: {:?}", e),
            }
        }
    }

    fn build_stream(
        device: &Device,
        config: &StreamConfig,
        sample_format: SampleFormat,
        channels: usize,
        buffer: Arc<Mutex<VecDeque<f32>>>,
    ) -> Result<Stream, Box<dyn std::error::Error>> {
        let err_fn = |err| eprintln!("Stream error: {}", err);

        let stream = match sample_format {
            SampleFormat::F32 => {
                let buf = Arc::clone(&buffer);
                device.build_input_stream(
                    config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        push_mono(data, channels, &buf);
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::I16 => {
                let buf = Arc::clone(&buffer);
                device.build_input_stream(
                    config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> =
                            data.iter().map(|&s| s as f32 / 32768.0).collect();
                        push_mono(&floats, channels, &buf);
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::U8 => {
                let buf = Arc::clone(&buffer);
                device.build_input_stream(
                    config,
                    move |data: &[u8], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> =
                            data.iter().map(|&s| (s as f32 - 128.0) / 128.0).collect();
                        push_mono(&floats, channels, &buf);
                    },
                    err_fn,
                    None,
                )?
            }
            SampleFormat::I32 => {
                let buf = Arc::clone(&buffer);
                device.build_input_stream(
                    config,
                    move |data: &[i32], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> =
                            data.iter().map(|&s| s as f32 / 2147483648.0).collect();
                        push_mono(&floats, channels, &buf);
                    },
                    err_fn,
                    None,
                )?
            }
            _ => return Err(format!("Unsupported sample format: {:?}", sample_format).into()),
        };

        Ok(stream)
    }

    fn init_diag_db() -> Result<Connection, Box<dyn std::error::Error>> {
        let db_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("larmindon_diag.sqlite");
        println!("[diag] Diagnostics DB: {}", db_path.display());
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS sessions (
                 id INTEGER PRIMARY KEY,
                 started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime')),
                 input_rate INTEGER,
                 chunk_size INTEGER,
                 needs_resample INTEGER
             );
             CREATE TABLE IF NOT EXISTS events (
                 id INTEGER PRIMARY KEY,
                 session_id INTEGER,
                 ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime')),
                 uptime_ms INTEGER,
                 event_type TEXT,
                 chunk_num INTEGER,
                 inference_ms INTEGER,
                 drain_samples INTEGER,
                 drain_audio_ms REAL,
                 resample_in INTEGER,
                 resample_out INTEGER,
                 resample_leftover INTEGER,
                 asr_buf_len INTEGER,
                 text_empty INTEGER,
                 text_preview TEXT,
                 error_msg TEXT
             );",
        )?;
        Ok(conn)
    }

    fn processing_loop(
        app_handle: AppHandle,
        buffer: Arc<Mutex<VecDeque<f32>>>,
        stop_flag: Arc<AtomicBool>,
        input_rate: usize,
        needs_resample: bool,
        chunk_size: usize,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let db = Self::init_diag_db()?;

        db.execute(
            "INSERT INTO sessions (input_rate, chunk_size, needs_resample) VALUES (?1, ?2, ?3)",
            rusqlite::params![input_rate as i64, chunk_size as i64, needs_resample as i64],
        )?;
        let session_id = db.last_insert_rowid();

        println!("Loading Nemotron model from {}...", MODEL_PATH);
        let mut model = Nemotron::from_pretrained(Path::new(MODEL_PATH), None)?;
        println!("Model loaded.");

        let mut resampler: Option<FftFixedIn<f32>> = if needs_resample {
            Some(FftFixedIn::<f32>::new(
                input_rate,
                ASR_SAMPLE_RATE,
                1024,
                1,
                1,
            )?)
        } else {
            None
        };

        let mut asr_buffer: Vec<f32> = Vec::with_capacity(chunk_size * 2);
        let loop_start = Instant::now();
        let mut chunk_num: u64 = 0;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = db.execute(
                    "INSERT INTO events (session_id, uptime_ms, event_type, chunk_num)
                     VALUES (?1, ?2, 'shutdown', ?3)",
                    rusqlite::params![session_id, loop_start.elapsed().as_millis() as i64, chunk_num as i64],
                );
                break;
            }

            let drained: Vec<f32> = {
                let mut guard = buffer.lock().unwrap();
                guard.drain(..).collect()
            };

            if drained.is_empty() {
                thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }

            let drain_count = drained.len();
            let drain_audio_ms = drain_count as f64 / input_rate as f64 * 1000.0;

            let (samples_16k, resample_in, resample_out, resample_leftover) =
                if let Some(ref mut resampler) = resampler {
                    let rs_chunk = resampler.input_frames_next();
                    let mut resampled = Vec::new();
                    let mut offset = 0;

                    while offset + rs_chunk <= drained.len() {
                        let input_chunk = &drained[offset..offset + rs_chunk];
                        match resampler.process(&[input_chunk], None) {
                            Ok(output) => {
                                if !output.is_empty() {
                                    resampled.extend_from_slice(&output[0]);
                                }
                            }
                            Err(e) => {
                                let _ = db.execute(
                                    "INSERT INTO events (session_id, uptime_ms, event_type, error_msg)
                                     VALUES (?1, ?2, 'resample_error', ?3)",
                                    rusqlite::params![session_id, loop_start.elapsed().as_millis() as i64, e.to_string()],
                                );
                            }
                        }
                        offset += rs_chunk;
                    }

                    let leftover = drained.len() - offset;
                    if leftover > 0 {
                        let mut guard = buffer.lock().unwrap();
                        for &s in &drained[offset..] {
                            guard.push_front(s);
                        }
                    }

                    let rs_in = drain_count - leftover;
                    let rs_out = resampled.len();
                    (resampled, rs_in, rs_out, leftover)
                } else {
                    let len = drained.len();
                    (drained, len, len, 0usize)
                };

            asr_buffer.extend_from_slice(&samples_16k);

            while asr_buffer.len() >= chunk_size {
                let chunk: Vec<f32> = asr_buffer.drain(..chunk_size).collect();
                let infer_start = Instant::now();
                match model.transcribe_chunk(&chunk) {
                    Ok(text) => {
                        let infer_ms = infer_start.elapsed().as_millis() as i64;
                        chunk_num += 1;
                        let is_empty = text.is_empty();
                        let preview = if text.len() > 200 {
                            text[..200].to_string()
                        } else {
                            text.clone()
                        };

                        let _ = db.execute(
                            "INSERT INTO events (session_id, uptime_ms, event_type, chunk_num,
                             inference_ms, drain_samples, drain_audio_ms,
                             resample_in, resample_out, resample_leftover,
                             asr_buf_len, text_empty, text_preview)
                             VALUES (?1, ?2, 'transcribe', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                            rusqlite::params![
                                session_id,
                                loop_start.elapsed().as_millis() as i64,
                                chunk_num as i64,
                                infer_ms,
                                drain_count as i64,
                                drain_audio_ms,
                                resample_in as i64,
                                resample_out as i64,
                                resample_leftover as i64,
                                asr_buffer.len() as i64,
                                is_empty as i64,
                                preview,
                            ],
                        );

                        if !is_empty {
                            let _ = app_handle
                                .emit("transcription", TranscriptionPayload { text });
                        }
                    }
                    Err(e) => {
                        let _ = db.execute(
                            "INSERT INTO events (session_id, uptime_ms, event_type, chunk_num,
                             inference_ms, error_msg)
                             VALUES (?1, ?2, 'asr_error', ?3, ?4, ?5)",
                            rusqlite::params![
                                session_id,
                                loop_start.elapsed().as_millis() as i64,
                                chunk_num as i64,
                                infer_start.elapsed().as_millis() as i64,
                                e.to_string(),
                            ],
                        );
                    }
                }
            }
        }

        Ok(())
    }
}

/// Downmix interleaved multi-channel audio to mono and push into the shared buffer.
fn push_mono(data: &[f32], channels: usize, buffer: &Arc<Mutex<VecDeque<f32>>>) {
    let mono: Vec<f32> = if channels == 1 {
        data.to_vec()
    } else {
        data.chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    if let Ok(mut guard) = buffer.lock() {
        guard.extend(mono.iter());
    }
}
