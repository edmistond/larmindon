use crate::audio_capture::{AudioCapture, AudioDevice, AudioStream, DeviceType};
use std::collections::VecDeque;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct PipewireBackend;

pub fn create_backend() -> Box<dyn AudioCapture> {
    Box::new(PipewireBackend)
}

impl AudioCapture for PipewireBackend {
    fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, Box<dyn Error>> {
        println!("[PipeWire] Enumerating devices...");
        let (tx, rx) = mpsc::channel::<Result<Vec<AudioDevice>, String>>();

        thread::spawn(move || {
            let result = enumerate_devices_thread();
            let _ = tx.send(result);
        });

        match rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(Ok(devices)) => Ok(devices),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err("Timeout enumerating PipeWire devices".into()),
        }
    }

    fn start(
        &self,
        device_id: Option<String>,
        buffer: Arc<Mutex<VecDeque<f32>>>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Box<dyn AudioStream>, Box<dyn Error>> {
        let device_id = device_id.ok_or("Device ID required for PipeWire")?;
        println!("[PipeWire] Starting stream for device: {}", device_id);

        // Parse device ID as node ID
        let target_node_id: u32 = device_id
            .parse()
            .map_err(|_| format!("Invalid device ID: {}", device_id))?;

        // Create channel for stream thread communication
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        // Spawn the stream thread
        let buffer_clone = Arc::clone(&buffer);
        let stop_flag_clone = Arc::clone(&stop_flag);

        let stream_thread = thread::spawn(move || {
            if let Err(e) =
                stream_thread_func(target_node_id, buffer_clone, stop_flag_clone, shutdown_rx)
            {
                eprintln!("[PipeWire] Stream thread error: {}", e);
            }
        });

        Ok(Box::new(PipewireStream {
            stop_flag,
            shutdown_tx,
            thread: Some(stream_thread),
        }))
    }

    fn name(&self) -> &'static str {
        "PipeWire"
    }
}

struct PipewireStream {
    stop_flag: Arc<AtomicBool>,
    shutdown_tx: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AudioStream for PipewireStream {
    fn stop(mut self: Box<Self>) {
        println!("[PipeWire] Stopping stream...");

        // Signal the thread to stop
        self.stop_flag.store(true, Ordering::Relaxed);
        let _ = self.shutdown_tx.send(());

        // Wait for thread to finish
        if let Some(thread) = self.thread.take() {
            match thread.join() {
                Ok(_) => println!("[PipeWire] Stream thread joined"),
                Err(e) => eprintln!("[PipeWire] Stream thread panicked: {:?}", e),
            }
        }

        println!("[PipeWire] Stream stopped");
    }
}

fn stream_thread_func(
    target_node_id: u32,
    buffer: Arc<Mutex<VecDeque<f32>>>,
    stop_flag: Arc<AtomicBool>,
    shutdown_rx: mpsc::Receiver<()>,
) -> Result<(), Box<dyn Error>> {
    use libspa::utils::Direction;
    use pipewire::main_loop::MainLoopBox;
    use pipewire::properties::properties;
    use pipewire::stream::{StreamBox, StreamFlags};

    println!(
        "[PipeWire] Stream thread starting for node {}",
        target_node_id
    );

    // Create mainloop and context
    let mainloop = MainLoopBox::new(None)?;
    let context = pipewire::context::ContextBox::new(&mainloop.loop_(), None)?;
    let core = context.connect(None)?;

    // Create properties for the stream
    let props = properties! {
        *pipewire::keys::MEDIA_TYPE => "Audio",
        *pipewire::keys::MEDIA_CATEGORY => "Capture",
        "target.object" => target_node_id.to_string(),
    };

    // Create the stream
    let stream = StreamBox::new(&core, "larmindon-capture", props)?;

    // Set up stream callbacks - MUST register all callbacks in ONE listener
    let buffer_clone = Arc::clone(&buffer);
    let stop_flag_clone = Arc::clone(&stop_flag);
    let mut sample_count: usize = 0;
    let mut last_log = std::time::Instant::now();
    let mut process_call_count: usize = 0;

    let _listener = stream
        .add_local_listener::<()>()
        .state_changed(|_stream, _user_data, old_state, new_state| {
            println!(
                "[PipeWire] Stream state changed: {:?} -> {:?}",
                old_state, new_state
            );
        })
        .process(move |stream, _user_data| {
            process_call_count += 1;

            if stop_flag_clone.load(Ordering::Relaxed) {
                return;
            }

            // Try to dequeue buffer
            let buffer_result = stream.dequeue_buffer();
            if buffer_result.is_none() {
                // No buffer available - this is normal, just return
                return;
            }

            let mut pw_buffer = buffer_result.unwrap();
            let datas = pw_buffer.datas_mut();
            let mut total_samples_this_buffer = 0;

            for data in datas.iter_mut() {
                // Get chunk info first before borrowing data mutably
                let chunk = data.chunk();
                let offset = chunk.offset() as usize;
                let size = chunk.size() as usize;
                let stride = chunk.stride() as usize;

                if size == 0 || stride == 0 {
                    continue;
                }

                // Now get the actual data
                if let Some(raw_data) = data.data() {
                    // Extract audio samples from the buffer
                    // Assuming f32 format for now (stride should be 4 for mono, 8 for stereo, etc.)
                    let bytes_per_sample = 4; // f32

                    // Process the data
                    if stride == bytes_per_sample {
                        // Mono f32 - copy directly
                        let samples = &raw_data[offset..offset + size];
                        let f32_samples: &[f32] = unsafe {
                            std::slice::from_raw_parts(
                                samples.as_ptr() as *const f32,
                                samples.len() / 4,
                            )
                        };
                        total_samples_this_buffer += f32_samples.len();

                        if let Ok(mut guard) = buffer_clone.lock() {
                            guard.extend(f32_samples.iter());
                        }
                    } else if stride == bytes_per_sample * 2 {
                        // Stereo f32 - downmix to mono
                        let samples = &raw_data[offset..offset + size];
                        let f32_samples: &[f32] = unsafe {
                            std::slice::from_raw_parts(
                                samples.as_ptr() as *const f32,
                                samples.len() / 4,
                            )
                        };

                        // Downmix stereo to mono
                        let mono: Vec<f32> = f32_samples
                            .chunks_exact(2)
                            .map(|frame| (frame[0] + frame[1]) / 2.0)
                            .collect();
                        total_samples_this_buffer += mono.len();

                        if let Ok(mut guard) = buffer_clone.lock() {
                            guard.extend(mono.iter());
                        }
                    } else {
                        // Other formats - log and skip for now
                        println!(
                            "[PipeWire] Unsupported format: stride={}, size={}",
                            stride, size
                        );
                    }
                }
            }

            // Log progress every second
            sample_count += total_samples_this_buffer;
            if last_log.elapsed().as_secs() >= 1 {
                if sample_count > 0 {
                    println!(
                        "[PipeWire] Captured {} samples in last second",
                        sample_count
                    );
                } else {
                    println!(
                        "[PipeWire] No audio data in last second (buffers received but empty)"
                    );
                }
                sample_count = 0;
                last_log = std::time::Instant::now();
            }

            // Buffer is automatically returned when pw_buffer is dropped
        })
        .register()?;

    // Connect the stream to capture from the target node
    let direction = Direction::Input;
    let mut params: Vec<&libspa::pod::Pod> = Vec::new();

    stream.connect(
        direction,
        Some(target_node_id),
        StreamFlags::empty(),
        &mut params,
    )?;

    println!("[PipeWire] Stream connected to node {}", target_node_id);

    // Activate the stream
    stream.set_active(true)?;
    println!("[PipeWire] Stream activated");

    // Check stream state
    let state = stream.state();
    println!("[PipeWire] Stream state: {:?}", state);

    // Run the mainloop with periodic stop checks
    let mainloop_ptr = &mainloop as *const MainLoopBox as usize;

    let check_timer = mainloop.loop_().add_timer(move |_| {
        // Check if we should stop
        if stop_flag.load(Ordering::Relaxed) {
            unsafe {
                let ml = &*(mainloop_ptr as *const MainLoopBox);
                ml.quit();
            }
        }

        // Also check shutdown channel
        if shutdown_rx.try_recv().is_ok() {
            unsafe {
                let ml = &*(mainloop_ptr as *const MainLoopBox);
                ml.quit();
            }
        }
    });

    // Update timer to run every 10ms
    check_timer
        .update_timer(
            Some(Duration::from_millis(10)),
            Some(Duration::from_millis(10)),
        )
        .into_result()?;

    // Run the mainloop
    mainloop.run();

    println!("[PipeWire] Stream thread exiting");
    Ok(())
}

fn enumerate_devices_thread() -> Result<Vec<AudioDevice>, String> {
    use pipewire::keys::*;
    use pipewire::main_loop::MainLoopBox;

    const APPLICATION_NAME_KEY: &str = "application.name";

    let result = (|| -> Result<Vec<AudioDevice>, Box<dyn Error>> {
        let mainloop = MainLoopBox::new(None)?;
        let context = pipewire::context::ContextBox::new(&mainloop.loop_(), None)?;
        let core = context.connect(None)?;
        let registry = core.get_registry()?;

        let apps = Arc::new(Mutex::new(Vec::new()));
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let monitors = Arc::new(Mutex::new(Vec::new()));

        let apps_clone = apps.clone();
        let inputs_clone = inputs.clone();
        let monitors_clone = monitors.clone();

        let _listener = registry
            .add_listener_local()
            .global(move |global| {
                if let Some(props) = global.props.as_ref() {
                    let media_class = props.get(*MEDIA_CLASS);
                    let node_id = global.id.to_string();

                    match media_class {
                        Some("Stream/Output/Audio") => {
                            let app_name = props
                                .get(APPLICATION_NAME_KEY)
                                .or_else(|| props.get(*NODE_NAME))
                                .unwrap_or("Unknown App");
                            apps_clone.lock().unwrap().push(AudioDevice {
                                id: node_id,
                                name: format!("[app] {}", app_name),
                                device_type: DeviceType::Application,
                            });
                        }
                        Some("Audio/Source") => {
                            let desc = props
                                .get(*NODE_DESCRIPTION)
                                .or_else(|| props.get(*NODE_NAME))
                                .unwrap_or("Unknown Input");
                            inputs_clone.lock().unwrap().push(AudioDevice {
                                id: node_id,
                                name: format!("[in] {}", desc),
                                device_type: DeviceType::Input,
                            });
                        }
                        Some("Audio/Sink") => {
                            let desc = props
                                .get(*NODE_DESCRIPTION)
                                .or_else(|| props.get(*NODE_NAME))
                                .unwrap_or("Unknown Output");
                            monitors_clone.lock().unwrap().push(AudioDevice {
                                id: node_id,
                                name: format!("[out] Monitor of {}", desc),
                                device_type: DeviceType::Monitor,
                            });
                        }
                        _ => {}
                    }
                }
            })
            .register();

        // Use raw pointer to allow timer to call quit()
        let mainloop_ptr = &mainloop as *const MainLoopBox as usize;

        let quit_timer = mainloop.loop_().add_timer(move |_| unsafe {
            let ml = &*(mainloop_ptr as *const MainLoopBox);
            ml.quit();
        });

        quit_timer
            .update_timer(Some(Duration::from_millis(600)), None)
            .into_result()?;

        // Run the mainloop - it will quit after 600ms
        mainloop.run();

        // Combine results
        let mut all_devices = Vec::new();
        all_devices.extend(apps.lock().unwrap().drain(..));
        all_devices.extend(inputs.lock().unwrap().drain(..));
        all_devices.extend(monitors.lock().unwrap().drain(..));

        println!("[PipeWire] Found {} devices", all_devices.len());
        Ok(all_devices)
    })();

    result.map_err(|e| format!("PipeWire error: {}", e))
}
