use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Result;
use rusqlite::params;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, now_ms};
use crate::embed;
use crate::models::QueueStatus;
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
    let count = |sql: &str| -> rusqlite::Result<i64> { db.query_row(sql, [], |r| r.get(0)) };
    let embedder_ready = state.embedder.lock().unwrap().is_some();
    let status = QueueStatus {
        embed_stale: count("SELECT COUNT(*) FROM notes WHERE embedding_status = 'STALE'")?,
        embed_pending: count("SELECT COUNT(*) FROM notes WHERE embedding_status = 'PENDING'")?,
        llm_stale: count("SELECT COUNT(*) FROM notes WHERE llm_status = 'STALE'")?,
        llm_pending: count("SELECT COUNT(*) FROM notes WHERE llm_status = 'PENDING'")?,
        sweep_active: state.sweep_active.load(Ordering::Relaxed),
        embedder_ready,
    };
    Ok(status)
}

fn emit_status(app: &AppHandle) {
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

async fn tick(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let settings = {
        let db = state.db.lock().unwrap();
        db::load_settings(&db)
    };
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
                 WHERE embedding_status = 'STALE' AND updated_at <= ?1
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
            emit_status(app);

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
            emit_status(app);
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
            let next: Option<String> = {
                let db = state.db.lock().unwrap();
                let cutoff = if sweep { now } else { now - debounce_ms };
                db.query_row(
                    "SELECT id FROM notes WHERE llm_status = 'STALE' AND updated_at <= ?1
                     ORDER BY updated_at ASC LIMIT 1",
                    params![cutoff],
                    |r| r.get(0),
                )
                .map(Some)
                .unwrap_or(None)
            };

            if let Some(id) = next {
                {
                    let db = state.db.lock().unwrap();
                    db.execute(
                        "UPDATE notes SET llm_status = 'PENDING' WHERE id = ?1",
                        params![id],
                    )?;
                }
                emit_status(app);
                match crate::ai::auto_tag_and_route(app, &id).await {
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
                emit_status(app);
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
