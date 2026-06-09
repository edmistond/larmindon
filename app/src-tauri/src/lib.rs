mod font_enumeration;

use larmindon_core::audio_capture::{ActiveSessionInfo, AudioDevice};
use larmindon_core::audio_engine::{AudioEngine, Command};
use larmindon_core::engine::registry::EngineRegistry;
use larmindon_core::engine::SegmentUpdate;
use larmindon_core::settings::Settings;
use larmindon_core::EngineEventSink;
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::menu::{Menu, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

const CAPTION_OVERLAY_LABEL: &str = "caption_overlay";

// ---------------------------------------------------------------------------
// Tauri event sink — bridges EngineEventSink to Tauri's event system
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct TauriEventSink(tauri::AppHandle);

#[derive(Serialize, Clone)]
struct TranscriptionPayload {
    text: String,
}

impl EngineEventSink for TauriEventSink {
    fn on_segment_update(&self, update: SegmentUpdate) {
        let _ = self.0.emit("transcription-update", &update);
    }

    fn on_error(&self, message: String) {
        let _ = self.0.emit(
            "transcription-error",
            TranscriptionPayload { text: message },
        );
    }

    fn on_source_switched(&self, device_id: String) {
        let _ = self.0.emit("source-switched", &device_id);
    }

    fn on_devices_changed(&self, devices: Vec<AudioDevice>) {
        let _ = self.0.emit("devices-changed", &devices);
    }
}

// ---------------------------------------------------------------------------
// Tauri command handlers
// ---------------------------------------------------------------------------

struct AudioEngineHandle {
    cmd_tx: mpsc::Sender<Command>,
    _thread: JoinHandle<()>,
}

#[tauri::command]
fn list_devices(engine: State<'_, Mutex<AudioEngineHandle>>) -> Result<Vec<AudioDevice>, String> {
    let handle = engine.lock().map_err(|e| e.to_string())?;
    let (reply_tx, reply_rx) = mpsc::channel();
    handle
        .cmd_tx
        .send(Command::ListDevices { reply: reply_tx })
        .map_err(|e| e.to_string())?;
    reply_rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_transcription(
    device_id: Option<String>,
    engine: State<'_, Mutex<AudioEngineHandle>>,
    current_settings: State<'_, Mutex<Settings>>,
) -> Result<(), String> {
    let settings = current_settings.lock().map_err(|e| e.to_string())?.clone();
    let handle = engine.lock().map_err(|e| e.to_string())?;
    handle
        .cmd_tx
        .send(Command::Start {
            device_id,
            settings,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_transcription(engine: State<'_, Mutex<AudioEngineHandle>>) -> Result<(), String> {
    let handle = engine.lock().map_err(|e| e.to_string())?;
    handle.cmd_tx.send(Command::Stop).map_err(|e| e.to_string())
}

#[tauri::command]
fn switch_source(
    device_id: String,
    engine: State<'_, Mutex<AudioEngineHandle>>,
) -> Result<(), String> {
    let handle = engine.lock().map_err(|e| e.to_string())?;
    handle
        .cmd_tx
        .send(Command::Reconnect { device_id })
        .map_err(|e| e.to_string())
}

fn show_caption_overlay(app_handle: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(CAPTION_OVERLAY_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Window creation on Windows is safer from async commands or separate
    // threads. This helper is used by both an async command and the menu path.
    WebviewWindowBuilder::new(
        app_handle,
        CAPTION_OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("Larmindon Captions")
    .inner_size(760.0, 180.0)
    .min_inner_size(360.0, 96.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn toggle_caption_overlay(app_handle: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(CAPTION_OVERLAY_LABEL) {
        if window.is_visible().map_err(|e| e.to_string())? {
            window.hide().map_err(|e| e.to_string())
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())
        }
    } else {
        show_caption_overlay(app_handle)
    }
}

#[tauri::command]
fn get_settings(current_settings: State<'_, Mutex<Settings>>) -> Result<Settings, String> {
    let settings = current_settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn save_settings(
    new_settings: Settings,
    current_settings: State<'_, Mutex<Settings>>,
    engine: State<'_, Mutex<AudioEngineHandle>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    new_settings.save()?;
    let mut settings = current_settings.lock().map_err(|e| e.to_string())?;
    *settings = new_settings.clone();
    // Hot-reload settings into the active processing thread (if any)
    if let Ok(handle) = engine.lock() {
        let _ = handle.cmd_tx.send(Command::UpdateSettings {
            settings: new_settings.clone(),
        });
    }
    let _ = app_handle.emit("settings-changed", new_settings);
    Ok(())
}

#[tauri::command]
fn get_default_settings() -> Settings {
    Settings::default()
}

#[tauri::command]
fn get_system_theme() -> String {
    // Use dark-light crate to detect system theme
    match dark_light::detect() {
        Ok(dark_light::Mode::Dark) => "dark".to_string(),
        Ok(dark_light::Mode::Light) => "light".to_string(),
        _ => "dark".to_string(),
    }
}

#[tauri::command]
fn get_system_fonts() -> Vec<String> {
    font_enumeration::get_system_fonts()
}

// ---------------------------------------------------------------------------
// Audio backend selection
// ---------------------------------------------------------------------------

fn create_audio_backend() -> Box<dyn larmindon_core::audio_capture::AudioCapture> {
    // Check for environment override first
    if let Ok(backend) = std::env::var("LARMINDON_AUDIO_BACKEND") {
        match backend.as_str() {
            "cpal" => {
                println!("Using CPAL backend (via LARMINDON_AUDIO_BACKEND env var)");
                #[cfg(feature = "cpal")]
                return larmindon_core::audio_capture::cpal::create_backend();
                #[cfg(not(feature = "cpal"))]
                panic!("CPAL feature not enabled but requested via LARMINDON_AUDIO_BACKEND environment variable. Rebuild with --features cpal");
            }
            "pipewire" => {
                #[cfg(all(target_os = "linux", feature = "pipewire"))]
                {
                    println!("Using PipeWire backend (via LARMINDON_AUDIO_BACKEND env var)");
                    return larmindon_core::audio_capture::pipewire::create_backend();
                }
                #[cfg(not(all(target_os = "linux", feature = "pipewire")))]
                panic!("PipeWire backend requested but feature not enabled. On Linux, rebuild with --features pipewire");
            }
            "wasapi" | "windows-composite" => {
                #[cfg(all(target_os = "windows", feature = "cpal"))]
                {
                    println!(
                        "Using Windows composite backend (via LARMINDON_AUDIO_BACKEND env var)"
                    );
                    return larmindon_core::audio_capture::windows_composite::create_backend();
                }
                #[cfg(not(all(target_os = "windows", feature = "cpal")))]
                panic!("WASAPI process backend is only available on Windows builds with the 'cpal' feature");
            }
            _ => {
                eprintln!(
                    "Unknown LARMINDON_AUDIO_BACKEND={backend}, using default backend selection"
                );
            }
        }
    }

    // Platform-specific defaults
    #[cfg(all(target_os = "linux", feature = "pipewire"))]
    {
        // On Linux, try PipeWire first
        println!("Attempting to use PipeWire backend...");

        // Test if PipeWire is available by trying to create a context
        match test_pipewire_available() {
            Ok(true) => {
                println!("PipeWire is available, using PipeWire backend");
                return larmindon_core::audio_capture::pipewire::create_backend();
            }
            Ok(false) => {
                println!("PipeWire not available, falling back to CPAL");
            }
            Err(e) => {
                eprintln!(
                    "Error testing PipeWire availability: {}, falling back to CPAL",
                    e
                );
            }
        }
    }

    // On Windows, default to the composite backend so per-application sources
    // show up alongside cpal devices in the picker.
    #[cfg(all(target_os = "windows", feature = "cpal"))]
    {
        println!("Using Windows composite backend (cpal + WASAPI process loopback)");
        return larmindon_core::audio_capture::windows_composite::create_backend();
    }

    // Default to CPAL (skipped on Windows when the composite backend above has
    // already returned).
    #[cfg(all(feature = "cpal", not(target_os = "windows")))]
    {
        println!("Using CPAL backend");
        larmindon_core::audio_capture::cpal::create_backend()
    }
    #[cfg(not(feature = "cpal"))]
    {
        panic!("No audio backend available. Enable either 'cpal' or 'pipewire' feature.");
    }
}

#[cfg(all(target_os = "linux", feature = "pipewire"))]
fn test_pipewire_available() -> Result<bool, Box<dyn std::error::Error>> {
    use pipewire::main_loop::MainLoopBox;

    pipewire::init();

    let result = (|| -> Result<bool, Box<dyn std::error::Error>> {
        let mainloop = MainLoopBox::new(None)?;
        let _context = pipewire::context::ContextBox::new(&mainloop.loop_(), None)?;
        Ok(true)
    })();

    result
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event: MenuEvent| match event.id().as_ref() {
            "clear_transcript" => {
                let _ = app.emit("clear-transcript", ());
            }
            "copy_transcript" => {
                let _ = app.emit("copy-transcript", ());
            }
            "preferences" => {
                let _ = app.emit("open-preferences", ());
            }
            "toggle_caption_overlay" => {
                let app_handle = app.clone();
                thread::spawn(move || {
                    if let Err(e) = toggle_caption_overlay(&app_handle) {
                        eprintln!("Failed to toggle caption overlay: {}", e);
                    }
                });
            }
            _ => {}
        })
        .setup(|app| {
            // Build menu bar with Edit submenu
            let handle = app.handle();
            let copy_transcript_item = MenuItem::with_id(
                handle,
                "copy_transcript",
                "Copy Transcript to Clipboard",
                true,
                Some("CmdOrCtrl+Shift+C"),
            )?;
            let clear_item = MenuItem::with_id(
                handle,
                "clear_transcript",
                "Clear Transcript",
                true,
                Some("CmdOrCtrl+K"),
            )?;
            let preferences_item = MenuItem::with_id(
                handle,
                "preferences",
                "Preferences…",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            let toggle_overlay_item = MenuItem::with_id(
                handle,
                "toggle_caption_overlay",
                "Show/Hide Overlay",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?;
            let app_menu = SubmenuBuilder::new(handle, "Larmindon")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .select_all()
                .copy()
                .separator()
                .item(&copy_transcript_item)
                .item(&clear_item)
                .separator()
                .item(&preferences_item)
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .item(&toggle_overlay_item)
                .build()?;
            let menu = Menu::with_items(handle, &[&app_menu, &edit_menu, &window_menu])?;
            app.set_menu(menu)?;
            // Load settings: file -> env overrides
            let settings = Settings::load().with_env_overrides();
            println!(
                "Settings: chunk_ms={}, intra={}, inter={}, punctuation_reset={}, model={}",
                settings.chunk_ms,
                settings.intra_threads,
                settings.inter_threads,
                settings.punctuation_reset,
                settings.model_path,
            );

            app.manage(Mutex::new(settings));

            let (cmd_tx, cmd_rx) = mpsc::channel();
            let app_handle = app.handle().clone();
            let event_sink = TauriEventSink(app_handle);

            // Shared session info for watcher ↔ engine communication
            let active_session_info = Arc::new(Mutex::new(ActiveSessionInfo::default()));

            // Create the appropriate audio capture backend
            let capture_backend = create_audio_backend();

            // Shared live toggle for diagnostics logging. Mirrors
            // settings.diagnostics_enabled and is updated by the engine on
            // Command::UpdateSettings so toggling off mid-session stops writes.
            let diag_enabled = {
                let s = app.state::<Mutex<Settings>>();
                let guard = s.lock().unwrap();
                Arc::new(AtomicBool::new(guard.diagnostics_enabled))
            };

            // Start persistent PipeWire device watcher (Linux only).
            // Must be stored in managed state to keep it alive for the app's lifetime.
            #[cfg(all(target_os = "linux", feature = "pipewire"))]
            {
                use larmindon_core::audio_capture::pipewire::PipewireBackend;

                let watcher_event_sink = event_sink.clone();
                let watcher_cmd_tx = cmd_tx.clone();
                let watcher_session_info = active_session_info.clone();
                let watcher_devices_cache = capture_backend
                    .as_any()
                    .and_then(|a| a.downcast_ref::<PipewireBackend>())
                    .map(|pw| pw.last_devices.clone());

                if let Some(devices_cache) = watcher_devices_cache {
                    let watcher = larmindon_core::audio_capture::pipewire::start_watcher(
                        watcher_event_sink,
                        watcher_cmd_tx,
                        watcher_session_info,
                        devices_cache,
                    );
                    app.manage(Mutex::new(watcher));
                } else {
                    eprintln!(
                        "Warning: Could not downcast audio backend to PipewireBackend for watcher"
                    );
                }
            }

            // Register the speech engines this build was compiled with.
            let mut registry = EngineRegistry::new();
            #[cfg(feature = "engine-nemotron")]
            registry.register(Arc::new(larmindon_engine_nemotron::NemotronFactory));
            let registry = Arc::new(registry);

            let session_info_for_engine = active_session_info.clone();
            let registry_for_engine = registry.clone();
            let engine_thread = thread::spawn(move || {
                let engine = AudioEngine::new(
                    event_sink,
                    cmd_rx,
                    capture_backend,
                    registry_for_engine,
                    session_info_for_engine,
                    diag_enabled,
                );
                engine.run();
            });

            app.manage(Mutex::new(AudioEngineHandle {
                cmd_tx,
                _thread: engine_thread,
            }));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            start_transcription,
            stop_transcription,
            switch_source,
            get_settings,
            save_settings,
            get_default_settings,
            get_system_theme,
            get_system_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
