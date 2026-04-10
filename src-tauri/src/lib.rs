mod commands;
mod db;
mod sidecar;

use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};

use db::Database;
use sidecar::SidecarManager;

#[derive(Default)]
struct RecordingState {
    is_recording: bool,
    is_paused: bool,
}

type Recording = Mutex<RecordingState>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(RecordingState::default()))
        .manage(SidecarManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::transcribe_audio,
            commands::analyze_delivery,
            commands::parse_document,
            commands::save_recording,
            commands::list_recordings,
            commands::get_recording,
            commands::save_analysis,
            commands::get_flagged_moments,
            commands::analyze_speech,
            commands::analyze_words,
            commands::analyze_audio,
            commands::generate_coaching,
            commands::evaluate_drill,
            commands::warmup_models,
            commands::save_coach_session,
            commands::get_coach_session_count,
            commands::get_latest_coach_session,
            commands::transcribe_fast,
            commands::coach_conversation_turn,
            commands::generate_first_impression,
            commands::speak_text,
            commands::extract_embedding,
            commands::match_speaker,
            commands::save_voice_profile,
            commands::get_voice_profile,
            commands::save_baseline,
            commands::get_baseline,
            commands::extract_clips,
            commands::list_subjects,
            commands::create_subject,
            commands::delete_subject,
            commands::assign_recording_subject,
            commands::assign_document_subject,
            commands::get_doc_chunks_for_subject,
            commands::list_study_items,
            commands::add_study_item,
            commands::update_study_item_status,
            commands::delete_study_item,
            commands::list_topics,
            commands::save_document,
            commands::list_documents,
            commands::delete_document,
            commands::get_all_doc_chunks,
            commands::rename_recording,
            commands::delete_recording,
            commands::get_drill_count_for_recording,
            commands::get_dashboard,
            commands::update_coaching_text,
        ])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize database
            let data_dir = app.path().app_data_dir().expect("No app data dir");
            let database = Database::open(&data_dir)
                .expect("Failed to open database");
            app.manage(database);

            // Build tray menu
            let record_toggle =
                MenuItemBuilder::with_id("record_toggle", "Start Session").build(app)?;
            let pause =
                MenuItemBuilder::with_id("pause", "Pause Session")
                    .enabled(false)
                    .build(app)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let open_window =
                MenuItemBuilder::with_id("open_window", "Open Duet Window").build(app)?;
            let settings =
                MenuItemBuilder::with_id("settings", "Settings...").build(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit Duet").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&record_toggle, &pause, &sep1, &open_window, &settings, &sep2, &quit])
                .build()?;

            // Clone menu items so we can update them from the event handler
            let record_toggle_ref = record_toggle.clone();
            let pause_ref = pause.clone();

            // Create tray icon — any click shows menu dropdown
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .menu_on_left_click(true)
                .tooltip("Duet")
                .on_menu_event(move |app, event| {
                    let state: State<Recording> = app.state();
                    match event.id().as_ref() {
                        "record_toggle" => {
                            let mut rec = state.lock().unwrap();
                            if rec.is_recording {
                                rec.is_recording = false;
                                rec.is_paused = false;
                                let _ = record_toggle_ref.set_text("Start Session");
                                let _ = pause_ref.set_text("Pause Session");
                                let _ = pause_ref.set_enabled(false);
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.emit("recording-stopped", ());
                                }
                            } else {
                                rec.is_recording = true;
                                rec.is_paused = false;
                                let _ = record_toggle_ref.set_text("Stop Session");
                                let _ = pause_ref.set_enabled(true);
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.emit("recording-started", ());
                                }
                            }
                        }
                        "pause" => {
                            let mut rec = state.lock().unwrap();
                            if rec.is_recording {
                                rec.is_paused = !rec.is_paused;
                                let label = if rec.is_paused {
                                    "Resume Session"
                                } else {
                                    "Pause Session"
                                };
                                let _ = pause_ref.set_text(label);
                                if let Some(window) = app.get_webview_window("main") {
                                    let event_name = if rec.is_paused {
                                        "recording-paused"
                                    } else {
                                        "recording-resumed"
                                    };
                                    let _ = window.emit(event_name, ());
                                }
                            }
                        }
                        "open_window" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "settings" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.emit("navigate", "settings");
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Intercept close: hide to tray instead of quitting
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
