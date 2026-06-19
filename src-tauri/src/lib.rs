mod ai;
mod commands;
mod db;
mod diff;
mod embed;
mod models;
mod prompts;
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
            // User-tuned prompts (Settings → Prompts) win over the built-in
            // defaults; load them before anything talks to the LLM.
            if let Some(ov) = db::load_prompt_overrides(&conn) {
                prompts::set_overrides(ov);
            }
            // Embedding model changed since last launch? Old vectors were
            // wiped — drain the re-embed sweep regardless of automation mode.
            let resweep = db::check_embed_model_version(&conn)?;
            if resweep {
                eprintln!(
                    "[embed] model changed to {} — embeddings reset, re-index sweep scheduled",
                    embed::EMBED_MODEL_ID
                );
            }
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
                sweep_active: Arc::new(AtomicBool::new(resweep)),
                current_activity: Arc::new(Mutex::new(None)),
                last_trash_purge: Arc::new(AtomicI64::new(0)),
                last_backup_check: Arc::new(AtomicI64::new(0)),
            });
            queue::spawn_worker(app.handle().clone());

            // Quick-capture: a small hidden always-on-top window summoned by
            // a global shortcut; Enter files the text as a new note.
            let capture = tauri::WebviewWindowBuilder::new(
                app,
                "capture",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Quick capture")
            .inner_size(540.0, 200.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .visible(false)
            .skip_taskbar(true)
            .center()
            .build();
            if let Err(e) = capture {
                eprintln!("[capture] window unavailable: {e}");
            }
            {
                use tauri_plugin_global_shortcut::{Builder as GsBuilder, GlobalShortcutExt, ShortcutState};
                app.handle().plugin(
                    GsBuilder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state() == ShortcutState::Pressed {
                                if let Some(win) = app.get_webview_window("capture") {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        })
                        .build(),
                )?;
                if let Err(e) = app.handle().global_shortcut().register("CmdOrCtrl+Shift+N") {
                    eprintln!("[capture] global shortcut unavailable: {e}");
                }
            }
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
            commands::restore_note,
            commands::purge_note,
            commands::empty_trash,
            commands::list_trashed_notes,
            commands::list_note_versions,
            commands::restore_note_version,
            commands::move_note,
            commands::set_note_pinned,
            commands::add_tag,
            commands::remove_tag,
            commands::accept_folder_suggestion,
            commands::dismiss_folder_suggestion,
            commands::list_notes,
            commands::search_notes,
            commands::related_notes,
            commands::find_similar_notes,
            commands::merge_notes,
            commands::board_clusters,
            commands::set_board_link,
            commands::clear_board_link,
            commands::set_board_order,
            commands::stale_ideas,
            commands::list_stickies,
            commands::cluster_stickies,
            commands::similar_sticky,
            commands::search_stickies,
            commands::create_sticky,
            commands::update_sticky,
            commands::delete_sticky,
            commands::restore_sticky,
            commands::promote_sticky,
            commands::roll_up_stickies,
            commands::stick_note,
            commands::list_folders,
            commands::create_folder,
            commands::move_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::list_tags,
            commands::delete_tag,
            commands::get_note_version,
            commands::ai_process_note,
            commands::ai_title_untitled,
            commands::ai_retag_all,
            commands::ai_bulletify_preview,
            commands::apply_note_rewrite,
            commands::ai_summarize_note,
            commands::ai_summarize_missing,
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
            commands::save_image_bytes,
            commands::export_notes,
            commands::backup_now,
            commands::plan_auto_arrange,
            commands::apply_auto_arrange,
            commands::import_notes,
            commands::get_prompt_defaults,
            commands::get_prompt_overrides,
            commands::set_prompt_overrides,
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
