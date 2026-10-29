mod audio_host;
mod endpoint_apo;
mod extension_bridge;
mod storage;

use audio_host::{
    AudioHost, ExtensionAudioStartRequest, NativeAudioInventory, NativeAudioStatus,
    NativeStartRequest,
};
use endpoint_apo::DirectAudioStatus;
use extension_bridge::{ExtensionBridge, ExtensionBridgeStatus};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use storage::StateStore;
use tauri::{Manager, State};
use uzjam_core::UzjamProfile;

struct AppState {
    audio: Arc<Mutex<AudioHost>>,
    store: Arc<Mutex<StateStore>>,
    bridge: ExtensionBridge,
}

impl AppState {
    fn new(data_directory: PathBuf) -> Self {
        let audio = Arc::new(Mutex::new(AudioHost::new()));
        let bridge = ExtensionBridge::start(&data_directory, Arc::clone(&audio));
        Self {
            audio,
            store: Arc::new(Mutex::new(StateStore::new(data_directory))),
            bridge,
        }
    }

    fn stop_audio(&self) {
        self.bridge.shutdown();
        if let Ok(mut audio) = self.audio.lock() {
            let _ = audio.stop();
        }
    }
}

fn join_error(error: impl std::fmt::Display) -> String {
    format!("The desktop worker could not complete: {error}")
}

#[tauri::command]
async fn native_audio_devices(state: State<'_, AppState>) -> Result<NativeAudioInventory, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .inventory()
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_audio_status(state: State<'_, AppState>) -> Result<NativeAudioStatus, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        let mut audio = audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?;
        Ok(audio.status())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_audio_start(
    request: NativeStartRequest,
    state: State<'_, AppState>,
) -> Result<NativeAudioStatus, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .start(request)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_audio_stop(state: State<'_, AppState>) -> Result<NativeAudioStatus, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .stop_with_status()
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_audio_recover(state: State<'_, AppState>) -> Result<NativeAudioStatus, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .recover()
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_audio_update_profile(
    profile: UzjamProfile,
    state: State<'_, AppState>,
) -> Result<NativeAudioStatus, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .update_profile(profile)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
fn native_extension_bridge_status(state: State<'_, AppState>) -> ExtensionBridgeStatus {
    state.bridge.status()
}

#[tauri::command]
async fn native_extension_audio_start(
    request: ExtensionAudioStartRequest,
    state: State<'_, AppState>,
) -> Result<NativeAudioStatus, String> {
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .start_external(request)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_extension_audio_stop(
    state: State<'_, AppState>,
) -> Result<NativeAudioStatus, String> {
    state.bridge.stop_capture();
    let audio = Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .stop_with_status()
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_direct_audio_status(
    output_device_id: Option<String>,
) -> Result<DirectAudioStatus, String> {
    tauri::async_runtime::spawn_blocking(move || endpoint_apo::status(output_device_id))
        .await
        .map_err(join_error)?
}

#[tauri::command]
async fn native_direct_audio_apply(
    profile: UzjamProfile,
    output_device_id: Option<String>,
) -> Result<DirectAudioStatus, String> {
    tauri::async_runtime::spawn_blocking(move || endpoint_apo::apply(profile, output_device_id))
        .await
        .map_err(join_error)?
}

#[tauri::command]
async fn native_load_state(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|_| "The settings store is unavailable.".to_string())?
            .load()
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_persist_state(snapshot: Value, state: State<'_, AppState>) -> Result<(), String> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|_| "The settings store is unavailable.".to_string())?
            .persist(&snapshot)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_clear_state(state: State<'_, AppState>) -> Result<(), String> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|_| "The settings store is unavailable.".to_string())?
            .clear()
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn native_prepare_shutdown(
    snapshot: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.bridge.shutdown();
    let audio = Arc::clone(&state.audio);
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let persist_result = store
            .lock()
            .map_err(|_| "The settings store is unavailable.".to_string())?
            .persist(&snapshot);
        let stop_result = audio
            .lock()
            .map_err(|_| "The audio engine state is unavailable.".to_string())?
            .stop();
        persist_result.and(stop_result)
    })
    .await
    .map_err(join_error)?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            app.manage(AppState::new(data_directory));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_audio_devices,
            native_audio_status,
            native_audio_start,
            native_audio_stop,
            native_audio_recover,
            native_audio_update_profile,
            native_extension_bridge_status,
            native_extension_audio_start,
            native_extension_audio_stop,
            native_direct_audio_status,
            native_direct_audio_apply,
            native_load_state,
            native_persist_state,
            native_clear_state,
            native_prepare_shutdown
        ])
        .build(tauri::generate_context!())
        .expect("UZjam desktop could not initialize");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            app_handle.state::<AppState>().stop_audio();
        }
    });
}
