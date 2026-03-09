use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use parakeet_rs::Nemotron;
use rubato::{FftFixedIn, Resampler};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::{AppHandle, Emitter};

use crate::audio_config;

const MODEL_PATH: &str = "/Users/edmistond/Downloads/prs-nemotron";
const ASR_SAMPLE_RATE: usize = 16000;
/// 560ms at 16kHz — required chunk size for Nemotron
const NEMOTRON_CHUNK_SIZE: usize = 8960;

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
    // Active session state
    stream: Option<Stream>,
    processing_thread: Option<JoinHandle<()>>,
    stop_flag: Option<Arc<AtomicBool>>,
}

impl AudioEngine {
    pub fn new(app_handle: AppHandle, cmd_rx: mpsc::Receiver<Command>) -> Self {
        Self {
            app_handle,
            cmd_rx,
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

        let processing_thread = thread::spawn(move || {
            if let Err(e) =
                Self::processing_loop(app_handle, buffer, stop_flag_thread, input_rate, needs_resample)
            {
                eprintln!("Processing loop error: {}", e);
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
            let _ = handle.join();
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

    fn processing_loop(
        app_handle: AppHandle,
        buffer: Arc<Mutex<VecDeque<f32>>>,
        stop_flag: Arc<AtomicBool>,
        input_rate: usize,
        needs_resample: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
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

        let mut asr_buffer: Vec<f32> = Vec::with_capacity(NEMOTRON_CHUNK_SIZE * 2);

        loop {
            if stop_flag.load(Ordering::Relaxed) {
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

            let samples_16k = if let Some(ref mut resampler) = resampler {
                let chunk_size = resampler.input_frames_next();
                let mut resampled = Vec::new();
                let mut offset = 0;

                while offset + chunk_size <= drained.len() {
                    let input_chunk = &drained[offset..offset + chunk_size];
                    match resampler.process(&[input_chunk], None) {
                        Ok(output) => {
                            if !output.is_empty() {
                                resampled.extend_from_slice(&output[0]);
                            }
                        }
                        Err(e) => {
                            eprintln!("Resampler error: {}", e);
                        }
                    }
                    offset += chunk_size;
                }

                // Put leftover samples back
                if offset < drained.len() {
                    let mut guard = buffer.lock().unwrap();
                    for &s in &drained[offset..] {
                        guard.push_front(s);
                    }
                }

                resampled
            } else {
                drained
            };

            asr_buffer.extend_from_slice(&samples_16k);

            while asr_buffer.len() >= NEMOTRON_CHUNK_SIZE {
                let chunk: Vec<f32> = asr_buffer.drain(..NEMOTRON_CHUNK_SIZE).collect();
                match model.transcribe_chunk(&chunk) {
                    Ok(text) => {
                        if !text.is_empty() {
                            let _ = app_handle
                                .emit("transcription", TranscriptionPayload { text });
                        }
                    }
                    Err(e) => {
                        eprintln!("ASR error: {}", e);
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
