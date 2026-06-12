use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Result;
use rusqlite::params;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, now_ms};
use crate::embed;
use crate::models::{ActionItem, AppSettings, QueueStatus};
use crate::state::AppState;

/// Spawn the background engine: a 1s tick loop that drains
/// Queue 1 (embeddings, high priority) before Queue 2 (LLM, low priority).
pub fn spawn_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if let Err(e) = tick(&app).await {
                eprintln!("[worker] {e:#}");
            }
        }
    });
}

pub fn queue_status(app: &AppHandle) -> Result<QueueStatus> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    // One table pass for all four counters instead of four COUNT queries —
    // this runs every worker tick and on every activity change.
    let (embed_stale, embed_pending, llm_stale, llm_pending) = db.query_row(
        "SELECT
            COUNT(*) FILTER (WHERE embedding_status = 'STALE'),
            COUNT(*) FILTER (WHERE embedding_status = 'PENDING'),
            COUNT(*) FILTER (WHERE llm_status = 'STALE'),
            COUNT(*) FILTER (WHERE llm_status = 'PENDING')
         FROM notes WHERE deleted_at IS NULL",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    // Phase is an atomic on purpose: never block status on the embedder mutex,
    // which is held for the whole duration of a download or an embed batch.
    let phase = state.embedder_phase.load(Ordering::Relaxed);
    let activity = state.current_activity.lock().unwrap().clone();
    let status = QueueStatus {
        embed_stale,
        embed_pending,
        llm_stale,
        llm_pending,
        sweep_active: state.sweep_active.load(Ordering::Relaxed),
        embedder_ready: phase == crate::state::embedder_phase::READY,
        embedder_state: crate::state::embedder_phase::as_str(phase).to_string(),
        current_activity: activity.as_ref().map(|(label, _)| label.clone()),
        current_note_id: activity.and_then(|(_, id)| id),
        embed_cooldown_until: state.embed_cooldown_until.load(Ordering::Relaxed),
        llm_cooldown_until: state.llm_cooldown_until.load(Ordering::Relaxed),
    };
    Ok(status)
}

/// Update the live "what is the worker doing" label (+ target note) and broadcast it.
pub fn set_activity(app: &AppHandle, activity: Option<(String, Option<String>)>) {
    let state = app.state::<AppState>();
    *state.current_activity.lock().unwrap() = activity;
    emit_status(app);
}

pub fn emit_status(app: &AppHandle) {
    if let Ok(s) = queue_status(app) {
        let _ = app.emit("queue-status", s);
    }
}

fn emit_note(app: &AppHandle, note_id: &str) {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    if let Ok(note) = db::get_note(&db, note_id) {
        let _ = app.emit("note-updated", note);
    }
}

/// Fire notifications for scheduled action items whose due time has passed.
fn check_due_reminders(app: &AppHandle, notify_system: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let now = now_ms();
    let due: Vec<ActionItem> = {
        let db = state.db.lock().unwrap();
        let mut stmt = db.prepare(
            "SELECT a.id, a.note_id, COALESCE(n.title, ''), a.text, a.category, a.status,
                    a.due_at, a.notified_at, a.created_at, a.updated_at
             FROM action_items a LEFT JOIN notes n ON n.id = a.note_id
             WHERE a.status = 'scheduled' AND a.due_at IS NOT NULL
               AND a.due_at <= ?1 AND a.notified_at IS NULL",
        )?;
        let rows = stmt.query_map(params![now], |r| {
            Ok(ActionItem {
                id: r.get(0)?,
                note_id: r.get(1)?,
                note_title: r.get(2)?,
                text: r.get(3)?,
                category: r.get(4)?,
                status: r.get(5)?,
                due_at: r.get(6)?,
                notified_at: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?;
        let due: Vec<ActionItem> = rows.filter_map(|r| r.ok()).collect();
        for item in &due {
            db.execute(
                "UPDATE action_items SET notified_at = ?1 WHERE id = ?2",
                params![now, item.id],
            )?;
        }
        due
    };

    for item in due {
        if notify_system {
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title("GoldFishy reminder")
                .body(&item.text)
                .show();
        }
        // The frontend decides whether to show an in-app banner.
        let _ = app.emit("action-due", &item);
    }
    Ok(())
}

const TRASH_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;
const PURGE_INTERVAL_MS: i64 = 6 * 3600 * 1000;

/// Hard-delete trash older than 30 days; runs at most every few hours.
fn purge_old_trash(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let now = now_ms();
    let last = state.last_trash_purge.load(Ordering::Relaxed);
    if now - last < PURGE_INTERVAL_MS {
        return Ok(());
    }
    state.last_trash_purge.store(now, Ordering::Relaxed);
    let db = state.db.lock().unwrap();
    let n = db.execute(
        "DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        params![now - TRASH_RETENTION_MS],
    )?;
    if n > 0 {
        eprintln!("[trash] purged {n} note(s) older than 30 days");
    }
    Ok(())
}

const BACKUP_CHECK_INTERVAL_MS: i64 = 30 * 60 * 1000;

/// Run the periodic markdown backup when one is due (checked every ~30 min).
fn maybe_backup(app: &AppHandle, settings: &AppSettings) {
    if settings.backup_dir.trim().is_empty() || settings.backup_interval_days == 0 {
        return;
    }
    let state = app.state::<AppState>();
    let now = now_ms();
    let last_check = state.last_backup_check.load(Ordering::Relaxed);
    if now - last_check < BACKUP_CHECK_INTERVAL_MS {
        return;
    }
    state.last_backup_check.store(now, Ordering::Relaxed);
    let last_backup: i64 = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT value FROM settings WHERE key = 'last_backup_at'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
    };
    if now - last_backup < settings.backup_interval_days as i64 * 86_400_000 {
        return;
    }
    match crate::commands::run_backup(app) {
        Ok(res) => {
            eprintln!("[backup] {} notes → {}", res.count, res.path);
            let _ = app.emit("backup-done", &res);
        }
        Err(e) => eprintln!("[backup] {e}"),
    }
}

async fn tick(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let settings = {
        let db = state.db.lock().unwrap();
        db::load_settings(&db)
    };

    // Reminders fire regardless of automation mode.
    if let Err(e) = check_due_reminders(app, settings.notify_system) {
        eprintln!("[reminders] {e:#}");
    }
    if let Err(e) = purge_old_trash(app) {
        eprintln!("[trash] {e:#}");
    }
    maybe_backup(app, &settings);

    let sweep = state.sweep_active.load(Ordering::Relaxed);
    let auto = settings.automation_mode == "auto";
    if !auto && !sweep {
        return Ok(());
    }
    let now = now_ms();

    // ---------- Queue 1: fast embedding pipeline ----------
    if now >= state.embed_cooldown_until.load(Ordering::Relaxed) {
        let debounce_ms = if sweep { 0 } else { settings.embed_debounce_secs as i64 * 1000 };
        let batch: Vec<(String, String)> = {
            let db = state.db.lock().unwrap();
            let mut stmt = db.prepare(
                "SELECT id, title, content FROM notes
                 WHERE embedding_status = 'STALE' AND deleted_at IS NULL AND updated_at <= ?1
                 ORDER BY updated_at ASC LIMIT 8",
            )?;
            let rows = stmt.query_map(params![now - debounce_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    db::ai_input(&r.get::<_, String>(1)?, &r.get::<_, String>(2)?),
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        if !batch.is_empty() {
            {
                let db = state.db.lock().unwrap();
                for (id, _) in &batch {
                    db.execute(
                        "UPDATE notes SET embedding_status = 'PENDING' WHERE id = ?1",
                        params![id],
                    )?;
                }
            }
            set_activity(
                app,
                Some((
                    format!(
                        "Indexing {} note{}…",
                        batch.len(),
                        if batch.len() == 1 { "" } else { "s" }
                    ),
                    if batch.len() == 1 {
                        Some(batch[0].0.clone())
                    } else {
                        None
                    },
                )),
            );

            let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
            match embed::embed_texts(app.clone(), texts).await {
                Ok(vectors) => {
                    {
                        let db = state.db.lock().unwrap();
                        for ((id, input), vec) in batch.iter().zip(vectors.iter()) {
                            db.execute(
                                "UPDATE notes SET embedding = ?1, embedding_status = 'CLEAN', last_embed_input = ?2
                                 WHERE id = ?3 AND embedding_status = 'PENDING'",
                                params![embed::to_blob(vec), input, id],
                            )?;
                        }
                    }
                    for (id, _) in &batch {
                        emit_note(app, id);
                    }
                }
                Err(e) => {
                    {
                        let db = state.db.lock().unwrap();
                        for (id, _) in &batch {
                            db.execute(
                                "UPDATE notes SET embedding_status = 'STALE' WHERE id = ?1 AND embedding_status = 'PENDING'",
                                params![id],
                            )?;
                        }
                    }
                    state.embed_cooldown_until.store(now + 60_000, Ordering::Relaxed);
                    let _ = app.emit("worker-error", format!("Embedding pipeline: {e:#}"));
                }
            }
            set_activity(app, None);
            // Queue 1 has strict priority — Queue 2 waits for the next tick.
            return Ok(());
        }
    }

    // ---------- Queue 2: heavy LLM pipeline ----------
    let llm_available = settings.llm_backend != "none";
    if llm_available && now >= state.llm_cooldown_until.load(Ordering::Relaxed) {
        let idle_ms = now - state.last_activity.load(Ordering::Relaxed);
        let debounce_ms = settings.llm_debounce_secs as i64 * 1000;
        if sweep || idle_ms >= debounce_ms {
            let next: Option<(String, String)> = {
                let db = state.db.lock().unwrap();
                let cutoff = if sweep { now } else { now - debounce_ms };
                db.query_row(
                    "SELECT id, title FROM notes
                     WHERE llm_status = 'STALE' AND deleted_at IS NULL AND updated_at <= ?1
                     ORDER BY updated_at ASC LIMIT 1",
                    params![cutoff],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map(Some)
                .unwrap_or(None)
            };

            if let Some((id, title)) = next {
                {
                    let db = state.db.lock().unwrap();
                    db.execute(
                        "UPDATE notes SET llm_status = 'PENDING' WHERE id = ?1",
                        params![id],
                    )?;
                }
                let mut label = title.trim().to_string();
                if label.is_empty() {
                    label = "Untitled".to_string();
                }
                set_activity(app, Some((format!("Organizing “{label}”…"), Some(id.clone()))));
                // One structured call covers title (if untitled), tags, folder
                // routing and action extraction — the old three-call sequence
                // paid per-call overhead twice more for the same result.
                match crate::ai::organize_note(app, &id).await {
                    Ok(note) => {
                        let _ = app.emit("note-updated", note);
                    }
                    Err(e) => {
                        {
                            let db = state.db.lock().unwrap();
                            db.execute(
                                "UPDATE notes SET llm_status = 'STALE' WHERE id = ?1 AND llm_status = 'PENDING'",
                                params![id],
                            )?;
                        }
                        state.llm_cooldown_until.store(now_ms() + 60_000, Ordering::Relaxed);
                        let _ = app.emit("worker-error", format!("AI pipeline: {e:#}"));
                    }
                }
                set_activity(app, None);
                return Ok(());
            }
        }
    }

    // Sweep bookkeeping: done when nothing processable remains.
    if sweep {
        let status = queue_status(app)?;
        let embed_done = status.embed_stale == 0 && status.embed_pending == 0;
        let llm_done = !llm_available || (status.llm_stale == 0 && status.llm_pending == 0);
        if embed_done && llm_done {
            state.sweep_active.store(false, Ordering::Relaxed);
            let _ = app.emit("sweep-done", ());
            emit_status(app);
        }
    }
    Ok(())
}
