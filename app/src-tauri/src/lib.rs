mod audio_config;
mod audio_engine;

use audio_engine::{AudioDevice, AudioEngine, Command};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use tauri::{Manager, State};

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
) -> Result<(), String> {
    let handle = engine.lock().map_err(|e| e.to_string())?;
    handle
        .cmd_tx
        .send(Command::Start { device_id })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_transcription(engine: State<'_, Mutex<AudioEngineHandle>>) -> Result<(), String> {
    let handle = engine.lock().map_err(|e| e.to_string())?;
    handle
        .cmd_tx
        .send(Command::Stop)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let (cmd_tx, cmd_rx) = mpsc::channel();
            let app_handle = app.handle().clone();

            let engine_thread = thread::spawn(move || {
                let engine = AudioEngine::new(app_handle, cmd_rx);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
