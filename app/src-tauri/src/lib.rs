mod audio_capture;
mod audio_config;
mod audio_engine;
mod settings;
mod vad;

use audio_capture::{ActiveSessionInfo, AudioDevice};
use audio_engine::{AudioEngine, Command};
use settings::Settings;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::menu::{Menu, MenuItem, MenuEvent, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

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
        .send(Command::Start { device_id, settings })
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

#[tauri::command]
fn get_settings(current_settings: State<'_, Mutex<Settings>>) -> Result<Settings, String> {
    let settings = current_settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn save_settings(
    new_settings: Settings,
    current_settings: State<'_, Mutex<Settings>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    new_settings.save()?;
    let mut settings = current_settings.lock().map_err(|e| e.to_string())?;
    *settings = new_settings.clone();
    let _ = app_handle.emit("settings-changed", new_settings);
    Ok(())
}

#[tauri::command]
fn get_default_settings() -> Settings {
    Settings::default()
}

/// Create the appropriate audio capture backend based on platform and features
fn create_audio_backend() -> Box<dyn audio_capture::AudioCapture> {
    // Check for environment override first
    if let Ok(backend) = std::env::var("LARMINDON_AUDIO_BACKEND") {
        match backend.as_str() {
            "cpal" => {
                println!("Using CPAL backend (via LARMINDON_AUDIO_BACKEND env var)");
                #[cfg(feature = "cpal")]
                return audio_capture::cpal::create_backend();
                #[cfg(not(feature = "cpal"))]
                panic!("CPAL feature not enabled but requested via LARMINDON_AUDIO_BACKEND environment variable. Rebuild with --features cpal");
            }
            "pipewire" => {
                #[cfg(all(target_os = "linux", feature = "pipewire"))]
                {
                    println!("Using PipeWire backend (via LARMINDON_AUDIO_BACKEND env var)");
                    return audio_capture::pipewire::create_backend();
                }
                #[cfg(not(all(target_os = "linux", feature = "pipewire")))]
                panic!("PipeWire backend requested but feature not enabled. On Linux, rebuild with --features pipewire");
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
                return audio_capture::pipewire::create_backend();
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

    // Default to CPAL
    #[cfg(feature = "cpal")]
    {
        println!("Using CPAL backend");
        audio_capture::cpal::create_backend()
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

#[cfg(not(all(target_os = "linux", feature = "pipewire")))]
fn test_pipewire_available() -> Result<bool, Box<dyn std::error::Error>> {
    Ok(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event: MenuEvent| {
            match event.id().as_ref() {
                "clear_transcript" => { let _ = app.emit("clear-transcript", ()); }
                "copy_transcript" => { let _ = app.emit("copy-transcript", ()); }
                "preferences" => { let _ = app.emit("open-preferences", ()); }
                _ => {}
            }
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
            let menu = Menu::with_items(handle, &[&app_menu, &edit_menu])?;
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

            // Shared session info for watcher ↔ engine communication
            let active_session_info = Arc::new(Mutex::new(ActiveSessionInfo::default()));

            // Create the appropriate audio capture backend
            let capture_backend = create_audio_backend();

            // Start persistent PipeWire device watcher (Linux only).
            // Must be stored in managed state to keep it alive for the app's lifetime.
            #[cfg(all(target_os = "linux", feature = "pipewire"))]
            {
                let watcher_app_handle = app.handle().clone();
                let watcher_cmd_tx = cmd_tx.clone();
                let watcher_session_info = active_session_info.clone();
                let watcher_devices_cache = capture_backend
                    .as_any()
                    .and_then(|a| {
                        a.downcast_ref::<audio_capture::pipewire::PipewireBackend>()
                    })
                    .map(|pw| pw.last_devices.clone());

                if let Some(devices_cache) = watcher_devices_cache {
                    let watcher = audio_capture::pipewire::start_watcher(
                        watcher_app_handle,
                        watcher_cmd_tx,
                        watcher_session_info,
                        devices_cache,
                    );
                    app.manage(Mutex::new(watcher));
                } else {
                    eprintln!("Warning: Could not downcast audio backend to PipewireBackend for watcher");
                }
            }

            let session_info_for_engine = active_session_info.clone();
            let engine_thread = thread::spawn(move || {
                let engine =
                    AudioEngine::new(app_handle, cmd_rx, capture_backend, session_info_for_engine);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

