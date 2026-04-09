use crate::audio_capture::{AudioCapture, AudioDevice, AudioStream, DeviceType};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use std::collections::VecDeque;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct CpalBackend;

pub fn create_backend() -> Box<dyn AudioCapture> {
    Box::new(CpalBackend)
}

impl AudioCapture for CpalBackend {
    fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, Box<dyn Error>> {
        let host = cpal::default_host();
        let mut devices = Vec::new();

        let default_input_name = host
            .default_input_device()
            .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()));

        // Input devices
        if let Ok(input_devices) = host.input_devices() {
            for device in input_devices {
                let raw_name = device
                    .description()
                    .map(|d| d.name().to_string())
                    .map_err(|e| format!("Failed to get device name: {}", e))?;

                if !raw_name.is_empty() {
                    devices.push(AudioDevice {
                        id: raw_name.clone(),
                        name: format!("[in] {}", raw_name),
                        device_type: DeviceType::Input,
                        is_default: default_input_name.as_deref() == Some(&raw_name),
                        application_name: None,
                    });
                }
            }
        }

        // On Windows, WASAPI allows monitoring output devices as loopback inputs.
        #[cfg(target_os = "windows")]
        if let Ok(output_devices) = host.output_devices() {
            for device in output_devices {
                let raw_name = device
                    .description()
                    .map(|d| d.name().to_string())
                    .map_err(|e| format!("Failed to get device name: {}", e))?;

                if !raw_name.is_empty() {
                    devices.push(AudioDevice {
                        id: raw_name.clone(),
                        name: format!("[out] {}", raw_name),
                        device_type: DeviceType::Monitor,
                        is_default: false,
                        application_name: None,
                    });
                }
            }
        }

        Ok(devices)
    }

    fn start(
        &self,
        device_id: Option<String>,
        buffer: Arc<Mutex<VecDeque<f32>>>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Box<dyn AudioStream>, Box<dyn Error>> {
        let host = cpal::default_host();

        let device = if let Some(ref id) = device_id {
            let find_by_id = |d: &Device| {
                d.description()
                    .map(|desc| desc.name() == *id)
                    .unwrap_or(false)
            };

            host.input_devices()?
                .find(find_by_id)
                .or_else(|| host.output_devices().ok()?.find(find_by_id))
                .ok_or_else(|| format!("No device found with ID: {}", id))?
        } else {
            host.default_input_device()
                .ok_or("No default input device found")?
        };

        let device_name = device
            .description()
            .map(|d| d.name().to_string())
            .map_err(|e| format!("Failed to get device name: {}", e))?;
        println!("CPAL: Using device: {}", device_name);

        let config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default config: {}", e))?;
        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();
        let channels = stream_config.channels as usize;

        println!(
            "CPAL: {} channels, {} Hz, {:?}",
            channels, stream_config.sample_rate, sample_format
        );

        let stream = build_stream(&device, &stream_config, sample_format, channels, buffer)?;
        stream.play()?;

        Ok(Box::new(CpalStream { stream, stop_flag }))
    }

    fn name(&self) -> &'static str {
        "CPAL"
    }
}

struct CpalStream {
    #[allow(dead_code)] // kept alive to prevent stream drop
    stream: Stream,
    stop_flag: Arc<AtomicBool>,
}

impl AudioStream for CpalStream {
    fn stop(self: Box<Self>) {
        self.stop_flag.store(true, Ordering::Relaxed);
        // Stream is dropped when self is dropped
    }
}

fn build_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: usize,
    buffer: Arc<Mutex<VecDeque<f32>>>,
) -> Result<Stream, Box<dyn Error>> {
    let err_fn = |err| eprintln!("CPAL stream error: {}", err);

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
                    let floats: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
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
                    let floats: Vec<f32> = data.iter().map(|&s| s as f32 / 2147483648.0).collect();
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
