use crate::audio_capture::{AudioCapture, AudioDevice, AudioStream, DeviceType};
use std::collections::VecDeque;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct PipewireBackend {
    /// Cache of last enumerated devices so start() can look up device type
    last_devices: Mutex<Vec<AudioDevice>>,
}

pub fn create_backend() -> Box<dyn AudioCapture> {
    Box::new(PipewireBackend {
        last_devices: Mutex::new(Vec::new()),
    })
}

impl AudioCapture for PipewireBackend {
    fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, Box<dyn Error>> {
        println!("[PipeWire] Enumerating devices...");
        let (tx, rx) = mpsc::channel::<Result<Vec<AudioDevice>, String>>();

        thread::spawn(move || {
            let result = enumerate_devices_thread();
            let _ = tx.send(result);
        });

        let devices = match rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(Ok(devices)) => devices,
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => return Err("Timeout enumerating PipeWire devices".into()),
        };

        // Cache for later lookup in start()
        *self.last_devices.lock().unwrap() = devices.clone();
        Ok(devices)
    }

    fn start(
        &self,
        device_id: Option<String>,
        buffer: Arc<Mutex<VecDeque<f32>>>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Box<dyn AudioStream>, Box<dyn Error>> {
        let device_id = device_id.ok_or("Device ID required for PipeWire")?;

        // Look up device type from cached enumeration
        let device_type = self
            .last_devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.id == device_id)
            .map(|d| d.device_type.clone())
            .unwrap_or(DeviceType::Application);

        println!(
            "[PipeWire] Starting stream for device: {} (type: {:?})",
            device_id, device_type
        );

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
            if let Err(e) = stream_thread_func(
                target_node_id,
                device_type,
                buffer_clone,
                stop_flag_clone,
                shutdown_rx,
            ) {
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
    device_type: DeviceType,
    buffer: Arc<Mutex<VecDeque<f32>>>,
    stop_flag: Arc<AtomicBool>,
    shutdown_rx: mpsc::Receiver<()>,
) -> Result<(), Box<dyn Error>> {
    use libspa::param::audio::{AudioFormat, AudioInfoRaw};
    use libspa::pod::serialize::PodSerializer;
    use libspa::pod::{Object, Pod, Value};
    use libspa::utils::Direction;
    use pipewire::main_loop::MainLoopBox;
    use pipewire::properties::properties;
    use pipewire::spa::param::ParamType;
    use pipewire::spa::utils::SpaTypes;
    use pipewire::stream::{StreamBox, StreamFlags};

    println!(
        "[PipeWire] Stream thread starting for node {} (type: {:?})",
        target_node_id, device_type
    );

    // Create mainloop and context
    let mainloop = MainLoopBox::new(None)?;
    let context = pipewire::context::ContextBox::new(&mainloop.loop_(), None)?;
    let core = context.connect(None)?;

    // Create properties for the stream
    let mut props = properties! {
        *pipewire::keys::MEDIA_TYPE => "Audio",
        *pipewire::keys::MEDIA_CATEGORY => "Capture",
        *pipewire::keys::MEDIA_ROLE => "Music",
        "target.object" => target_node_id.to_string(),
    };

    // For sink monitors, we need to tell PipeWire to capture from the monitor ports
    if device_type == DeviceType::Monitor {
        props.insert("stream.capture.sink", "true");
        println!("[PipeWire] Capturing from sink monitor ports");
    }

    // Create the stream
    let stream = StreamBox::new(&core, "larmindon-capture", props)?;

    // Set up stream callbacks - MUST register all callbacks in ONE listener
    let buffer_clone = Arc::clone(&buffer);
    let stop_flag_clone = Arc::clone(&stop_flag);

    let _listener = stream
        .add_local_listener::<()>()
        .state_changed(|_stream, _user_data, old_state, new_state| {
            println!(
                "[PipeWire] Stream state changed: {:?} -> {:?}",
                old_state, new_state
            );
        })
        .param_changed(|_stream, _user_data, id, param| {
            if param.is_some() {
                println!("[PipeWire] Format negotiated (param id={})", id);
            }
        })
        .process(move |stream, _user_data| {
            if stop_flag_clone.load(Ordering::Relaxed) {
                return;
            }

            let Some(mut pw_buffer) = stream.dequeue_buffer() else {
                return;
            };

            let datas = pw_buffer.datas_mut();

            for data in datas.iter_mut() {
                let chunk = data.chunk();
                let offset = chunk.offset() as usize;
                let size = chunk.size() as usize;
                let stride = chunk.stride() as usize;

                if size == 0 || stride == 0 {
                    continue;
                }

                if let Some(raw_data) = data.data() {
                    let bytes_per_sample = 4; // f32

                    if stride == bytes_per_sample {
                        // Mono f32
                        let samples = &raw_data[offset..offset + size];
                        let f32_samples: &[f32] = unsafe {
                            std::slice::from_raw_parts(
                                samples.as_ptr() as *const f32,
                                samples.len() / 4,
                            )
                        };

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

                        let mono: Vec<f32> = f32_samples
                            .chunks_exact(2)
                            .map(|frame| (frame[0] + frame[1]) / 2.0)
                            .collect();

                        if let Ok(mut guard) = buffer_clone.lock() {
                            guard.extend(mono.iter());
                        }
                    } else {
                        println!(
                            "[PipeWire] Unsupported stride: {} (size={})",
                            stride, size
                        );
                    }
                }
            }

        })
        .register()?;

    // Build SPA format pod: request F32LE audio, let PipeWire negotiate rate/channels
    let mut audio_info = AudioInfoRaw::new();
    audio_info.set_format(AudioFormat::F32LE);

    let obj = Object {
        type_: SpaTypes::ObjectParamFormat.as_raw(),
        id: ParamType::EnumFormat.as_raw(),
        properties: audio_info.into(),
    };
    let values: Vec<u8> = PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &Value::Object(obj),
    )
    .unwrap()
    .0
    .into_inner();
    let mut params = [Pod::from_bytes(&values).unwrap()];

    // Connect with AUTOCONNECT + MAP_BUFFERS + RT_PROCESS (required for process callback)
    // Use None for target_id — target.object property handles routing
    stream.connect(
        Direction::Input,
        None,
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
        &mut params,
    )?;

    println!("[PipeWire] Stream connected, targeting node {}", target_node_id);

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

/// Monitor device info: the AudioDevice plus the node.name for matching against default sink metadata
struct MonitorInfo {
    device: AudioDevice,
    node_name: String,
}

fn enumerate_devices_thread() -> Result<Vec<AudioDevice>, String> {
    use pipewire::keys::*;
    use pipewire::main_loop::MainLoopBox;
    use pipewire::metadata::{Metadata, MetadataListener};
    use pipewire::properties::PropertiesBox;
    use pipewire::registry::GlobalObject;
    use pipewire::types::ObjectType;

    const APPLICATION_NAME_KEY: &str = "application.name";

    let result = (|| -> Result<Vec<AudioDevice>, Box<dyn Error>> {
        let mainloop = MainLoopBox::new(None)?;
        let context = pipewire::context::ContextBox::new(&mainloop.loop_(), None)?;
        let core = context.connect(None)?;
        let registry = core.get_registry()?;

        let apps = Arc::new(Mutex::new(Vec::new()));
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let monitors: Arc<Mutex<Vec<MonitorInfo>>> = Arc::new(Mutex::new(Vec::new()));
        let default_sink_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Store metadata globals to bind after the registry listener is set up
        let metadata_globals: Arc<Mutex<Vec<GlobalObject<PropertiesBox>>>> =
            Arc::new(Mutex::new(Vec::new()));

        let apps_clone = apps.clone();
        let inputs_clone = inputs.clone();
        let monitors_clone = monitors.clone();
        let metadata_globals_clone = metadata_globals.clone();

        let _listener = registry
            .add_listener_local()
            .global(move |global| {
                // Collect metadata globals for later binding
                if global.type_ == ObjectType::Metadata {
                    metadata_globals_clone
                        .lock()
                        .unwrap()
                        .push(global.to_owned());
                    return;
                }

                if let Some(props) = global.props.as_ref() {
                    let media_class = props.get(*MEDIA_CLASS);
                    // Use object.serial for device ID — target.object matches against serial,
                    // not the registry global.id (they differ for app streams)
                    let node_id = props
                        .get("object.serial")
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| global.id.to_string());

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
                                is_default: false,
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
                                is_default: false,
                            });
                        }
                        Some("Audio/Sink") => {
                            let desc = props
                                .get(*NODE_DESCRIPTION)
                                .or_else(|| props.get(*NODE_NAME))
                                .unwrap_or("Unknown Output");
                            let node_name = props.get(*NODE_NAME).unwrap_or("").to_string();
                            monitors_clone.lock().unwrap().push(MonitorInfo {
                                device: AudioDevice {
                                    id: node_id,
                                    name: format!("[out] Monitor of {}", desc),
                                    device_type: DeviceType::Monitor,
                                    is_default: false,
                                },
                                node_name,
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

        // Second pass: bind metadata objects to query default sink
        let metadata_objs = metadata_globals.lock().unwrap();
        if !metadata_objs.is_empty() {
            // Keep bound metadata + listeners alive during second mainloop run
            let mut _bound_metadata: Vec<(Metadata, MetadataListener)> = Vec::new();

            for obj in metadata_objs.iter() {
                if let Ok(metadata) = registry.bind::<Metadata, _>(obj) {
                    let dsn = default_sink_name.clone();
                    let listener = metadata
                        .add_listener_local()
                        .property(move |_subject, key, _type, value| {
                            if key == Some("default.audio.sink") {
                                if let Some(val) = value {
                                    // Value is JSON like {"name":"alsa_output.pci-..."}
                                    // Parse the name field
                                    if let Some(name) = parse_metadata_name(val) {
                                        println!(
                                            "[PipeWire] Default audio sink: {}",
                                            name
                                        );
                                        *dsn.lock().unwrap() = Some(name);
                                    }
                                }
                            }
                            0
                        })
                        .register();
                    _bound_metadata.push((metadata, listener));
                }
            }
            drop(metadata_objs);

            // Brief second mainloop run to receive metadata properties
            let mainloop_ptr2 = &mainloop as *const MainLoopBox as usize;
            let quit_timer2 = mainloop.loop_().add_timer(move |_| unsafe {
                let ml = &*(mainloop_ptr2 as *const MainLoopBox);
                ml.quit();
            });
            quit_timer2
                .update_timer(Some(Duration::from_millis(200)), None)
                .into_result()?;
            mainloop.run();
        } else {
            drop(metadata_objs);
        }

        // Mark the default monitor based on metadata
        let default_name = default_sink_name.lock().unwrap().clone();
        let mut monitors_vec = monitors.lock().unwrap();
        if let Some(ref default_name) = default_name {
            for info in monitors_vec.iter_mut() {
                if info.node_name == *default_name {
                    info.device.is_default = true;
                }
            }
        }

        // Combine results
        let mut all_devices = Vec::new();
        all_devices.extend(apps.lock().unwrap().drain(..));
        all_devices.extend(inputs.lock().unwrap().drain(..));
        all_devices.extend(monitors_vec.drain(..).map(|m| m.device));

        println!("[PipeWire] Found {} devices", all_devices.len());
        Ok(all_devices)
    })();

    result.map_err(|e| format!("PipeWire error: {}", e))
}

/// Parse the "name" field from PipeWire metadata JSON value.
/// e.g. `{"name":"alsa_output.pci-0000_0e_00.4.analog-stereo"}` -> `Some("alsa_output...")`
fn parse_metadata_name(json_value: &str) -> Option<String> {
    // Simple JSON parsing — avoid pulling in serde_json just for this
    let trimmed = json_value.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    // Look for "name":"<value>"
    let name_key = "\"name\":\"";
    let start = trimmed.find(name_key)? + name_key.len();
    let rest = &trimmed[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}
