mod ai;
mod commands;
mod db;
mod diff;
mod embed;
mod models;
mod queue;
mod state;

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8};
use std::sync::{Arc, Mutex};

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let conn = db::open(app.handle())?;
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                embedder: Arc::new(Mutex::new(None)),
                embedder_phase: Arc::new(AtomicU8::new(state::embedder_phase::COLD)),
                embedder_init: Arc::new(Mutex::new(())),
                last_activity: Arc::new(AtomicI64::new(db::now_ms())),
                sidecar: Arc::new(tokio::sync::Mutex::new(None)),
                http: reqwest::Client::new(),
                embed_cooldown_until: Arc::new(AtomicI64::new(0)),
                llm_cooldown_until: Arc::new(AtomicI64::new(0)),
                sweep_active: Arc::new(AtomicBool::new(false)),
                current_activity: Arc::new(Mutex::new(None)),
            });
            queue::spawn_worker(app.handle().clone());
            // Warm the embedder off the UI thread right away: the first-launch
            // model download starts immediately (with visible status) instead
            // of surprising the user mid-typing.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = embed::ensure_embedder_blocking(&handle) {
                    eprintln!("[embedder] warm-up failed: {e:#}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_note,
            commands::get_note,
            commands::update_note,
            commands::delete_note,
            commands::move_note,
            commands::set_note_pinned,
            commands::add_tag,
            commands::remove_tag,
            commands::accept_folder_suggestion,
            commands::dismiss_folder_suggestion,
            commands::list_notes,
            commands::search_notes,
            commands::related_notes,
            commands::list_folders,
            commands::create_folder,
            commands::move_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::list_tags,
            commands::delete_tag,
            commands::ai_process_note,
            commands::ai_title_untitled,
            commands::ai_bulletify,
            commands::ai_summarize_collection,
            commands::get_collection_summary,
            commands::test_llm,
            commands::download_model,
            commands::get_settings,
            commands::set_settings,
            commands::reindex_all,
            commands::queue_status,
            commands::list_queued_notes,
            commands::list_action_items,
            commands::extract_actions_note,
            commands::create_action_item,
            commands::set_action_status,
            commands::set_action_category,
            commands::set_action_due,
            commands::delete_action_item,
            commands::notify_activity,
            commands::get_data_dir,
            commands::save_image,
            commands::export_notes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Best-effort: don't leave an orphaned llama-server behind.
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut guard) = state.sidecar.try_lock() {
                        if let Some(proc) = guard.as_mut() {
                            let _ = proc.child.start_kill();
                        }
                        *guard = None;
                    }
                }
            }
        });
}
