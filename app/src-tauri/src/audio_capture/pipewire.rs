use crate::audio_capture::{AudioCapture, AudioDevice, AudioStream, DeviceType};
use std::collections::VecDeque;
use std::error::Error;
use std::sync::atomic::AtomicBool;
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
        _buffer: Arc<Mutex<VecDeque<f32>>>,
        _stop_flag: Arc<AtomicBool>,
    ) -> Result<Box<dyn AudioStream>, Box<dyn Error>> {
        let device_id = device_id.ok_or("Device ID required for PipeWire")?;
        println!("[PipeWire] Would start stream for device: {}", device_id);
        println!("[PipeWire] Note: Audio capture not yet implemented, returning dummy stream");

        // For now, return a dummy stream since the full implementation has API issues
        Ok(Box::new(PipewireStream))
    }

    fn name(&self) -> &'static str {
        "PipeWire"
    }
}

struct PipewireStream;

impl AudioStream for PipewireStream {
    fn stop(self: Box<Self>) {
        println!("[PipeWire] Stream stopped");
    }
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
