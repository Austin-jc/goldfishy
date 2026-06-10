use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::ai;
use crate::db::{self, now_ms};
use crate::diff;
use crate::embed;
use crate::models::{AppSettings, Folder, Note, QueueStatus, TagCount};
use crate::queue;
use crate::state::AppState;

type CmdResult<T> = Result<T, String>;

fn estr(e: impl std::fmt::Display) -> String {
    format!("{e}")
}

fn eanyhow(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn touch_activity(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.last_activity.store(now_ms(), Ordering::Relaxed);
}

// ---------------------------------------------------------------- notes

#[tauri::command]
pub fn create_note(app: AppHandle, folder_id: Option<String>) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let empty_input = db::ai_input("", "");
    db.execute(
        "INSERT INTO notes(id, title, content, folder_id, created_at, updated_at,
                           embedding_status, llm_status, last_embed_input, last_llm_input)
         VALUES (?1, '', '', ?2, ?3, ?3, 'CLEAN', 'CLEAN', ?4, ?4)",
        params![id, folder_id, now, empty_input],
    )
    .map_err(estr)?;
    state.last_activity.store(now, Ordering::Relaxed);
    db::get_note(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub fn get_note(app: AppHandle, id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::get_note(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub fn update_note(app: AppHandle, id: String, title: String, content: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let old = db::get_note(&db, &id).map_err(eanyhow)?;
    let now = now_ms();
    state.last_activity.store(now, Ordering::Relaxed);

    if old.title != title || old.content != content {
        db.execute(
            "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, content, now, id],
        )
        .map_err(estr)?;

        let new_input = db::ai_input(&title, &content);
        let (last_embed, last_llm): (Option<String>, Option<String>) = db
            .query_row(
                "SELECT last_embed_input, last_llm_input FROM notes WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(estr)?;

        // Diff checking: minor typo fixes don't re-enter the queues.
        if !old.has_embedding || diff::significant_change(last_embed.as_deref(), &new_input) {
            db.execute(
                "UPDATE notes SET embedding_status = 'STALE' WHERE id = ?1",
                params![id],
            )
            .map_err(estr)?;
        }
        if diff::significant_change(last_llm.as_deref(), &new_input) {
            db.execute("UPDATE notes SET llm_status = 'STALE' WHERE id = ?1", params![id])
                .map_err(estr)?;
        }
    }
    db::get_note(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub fn delete_note(app: AppHandle, id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub fn move_note(app: AppHandle, id: String, folder_id: Option<String>) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE notes SET folder_id = ?1, suggested_folder_id = NULL WHERE id = ?2",
        params![folder_id, id],
    )
    .map_err(estr)?;
    db::get_note(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub fn add_tag(app: AppHandle, note_id: String, tag: String) -> CmdResult<Note> {
    let tag = tag.trim().to_lowercase().replace(char::is_whitespace, "-");
    if tag.is_empty() {
        return Err("Tag is empty".into());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO note_tags(note_id, tag, source) VALUES (?1, ?2, 'manual')
         ON CONFLICT(note_id, tag) DO UPDATE SET source = 'manual'",
        params![note_id, tag],
    )
    .map_err(estr)?;
    db::get_note(&db, &note_id).map_err(eanyhow)
}

#[tauri::command]
pub fn remove_tag(app: AppHandle, note_id: String, tag: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "DELETE FROM note_tags WHERE note_id = ?1 AND tag = ?2",
        params![note_id, tag],
    )
    .map_err(estr)?;
    db::get_note(&db, &note_id).map_err(eanyhow)
}

#[tauri::command]
pub fn accept_folder_suggestion(app: AppHandle, note_id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE notes SET folder_id = suggested_folder_id, suggested_folder_id = NULL
         WHERE id = ?1 AND suggested_folder_id IS NOT NULL",
        params![note_id],
    )
    .map_err(estr)?;
    db::get_note(&db, &note_id).map_err(eanyhow)
}

#[tauri::command]
pub fn dismiss_folder_suggestion(app: AppHandle, note_id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE notes SET suggested_folder_id = NULL WHERE id = ?1",
        params![note_id],
    )
    .map_err(estr)?;
    db::get_note(&db, &note_id).map_err(eanyhow)
}

#[tauri::command]
pub fn list_notes(app: AppHandle, folder_id: Option<String>, tag: Option<String>) -> CmdResult<Vec<Note>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_notes(&db, folder_id.as_deref(), tag.as_deref()).map_err(eanyhow)
}

// ---------------------------------------------------------------- search

fn fts_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
pub async fn search_notes(app: AppHandle, query: String, mode: String) -> CmdResult<Vec<Note>> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }

    if mode == "semantic" {
        let vectors = embed::embed_texts(app.clone(), vec![q]).await.map_err(eanyhow)?;
        let qv = vectors
            .into_iter()
            .next()
            .ok_or_else(|| "embedding failed".to_string())?;

        let state = app.state::<AppState>();
        let mut scored: Vec<(String, f32)> = {
            let db = state.db.lock().unwrap();
            let mut stmt = db
                .prepare("SELECT id, embedding FROM notes WHERE embedding IS NOT NULL")
                .map_err(estr)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(estr)?;
            rows.filter_map(|r| r.ok())
                .map(|(id, blob)| {
                    let score = embed::cosine(&qv, &embed::from_blob(&blob));
                    (id, score)
                })
                .collect()
        };
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.retain(|(_, s)| *s > 0.25);
        scored.truncate(30);

        let ids: Vec<String> = scored.iter().map(|(id, _)| id.clone()).collect();
        let db = state.db.lock().unwrap();
        let mut notes = db::get_notes_by_ids(&db, &ids).map_err(eanyhow)?;
        let score_map: HashMap<&str, f32> = scored.iter().map(|(id, s)| (id.as_str(), *s)).collect();
        for n in notes.iter_mut() {
            n.score = score_map.get(n.id.as_str()).copied();
        }
        Ok(notes)
    } else {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let match_q = fts_query(&q);
        if match_q.is_empty() {
            return Ok(vec![]);
        }
        let mut stmt = db
            .prepare(
                "SELECT n.id,
                        snippet(notes_fts, 1, '<mark>', '</mark>', ' … ', 14),
                        bm25(notes_fts)
                 FROM notes_fts
                 JOIN notes n ON n.rowid = notes_fts.rowid
                 WHERE notes_fts MATCH ?1
                 ORDER BY bm25(notes_fts)
                 LIMIT 50",
            )
            .map_err(estr)?;
        let rows: Vec<(String, String, f64)> = stmt
            .query_map(params![match_q], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(estr)?
            .filter_map(|r| r.ok())
            .collect();

        let ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
        let mut notes = db::get_notes_by_ids(&db, &ids).map_err(eanyhow)?;
        let meta: HashMap<&str, (&str, f64)> = rows
            .iter()
            .map(|(id, snip, rank)| (id.as_str(), (snip.as_str(), *rank)))
            .collect();
        for n in notes.iter_mut() {
            if let Some((snip, rank)) = meta.get(n.id.as_str()) {
                n.snippet = Some(snip.to_string());
                n.score = Some(-*rank as f32);
            }
        }
        Ok(notes)
    }
}

// ---------------------------------------------------------------- folders & tags

#[tauri::command]
pub fn list_folders(app: AppHandle) -> CmdResult<Vec<Folder>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_folders(&db).map_err(eanyhow)
}

#[tauri::command]
pub fn create_folder(app: AppHandle, name: String, parent_id: Option<String>) -> CmdResult<Folder> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name is empty".into());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    db.execute(
        "INSERT INTO folders(id, name, parent_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, parent_id, now],
    )
    .map_err(estr)?;
    Ok(Folder { id, name, parent_id, created_at: now })
}

#[tauri::command]
pub fn rename_folder(app: AppHandle, id: String, name: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("UPDATE folders SET name = ?1 WHERE id = ?2", params![name.trim(), id])
        .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub fn delete_folder(app: AppHandle, id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub fn list_tags(app: AppHandle) -> CmdResult<Vec<TagCount>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_tags(&db).map_err(eanyhow)
}

// ---------------------------------------------------------------- AI actions

#[tauri::command]
pub async fn ai_process_note(app: AppHandle, note_id: String) -> CmdResult<Note> {
    {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.execute("UPDATE notes SET llm_status = 'PENDING' WHERE id = ?1", params![note_id])
            .map_err(estr)?;
    }
    match ai::auto_tag_and_route(&app, &note_id).await {
        Ok(note) => {
            let _ = app.emit("note-updated", &note);
            Ok(note)
        }
        Err(e) => {
            let state = app.state::<AppState>();
            let db = state.db.lock().unwrap();
            let _ = db.execute(
                "UPDATE notes SET llm_status = 'STALE' WHERE id = ?1",
                params![note_id],
            );
            Err(eanyhow(e))
        }
    }
}

#[tauri::command]
pub async fn ai_bulletify(app: AppHandle, note_id: String) -> CmdResult<Note> {
    let note = ai::bulletify(&app, &note_id).await.map_err(eanyhow)?;
    let _ = app.emit("note-updated", &note);
    Ok(note)
}

#[tauri::command]
pub async fn ai_summarize_collection(app: AppHandle, kind: String, key: String) -> CmdResult<String> {
    ai::summarize_collection(&app, &kind, &key).await.map_err(eanyhow)
}

#[derive(Serialize)]
pub struct CollectionSummary {
    pub summary: String,
    pub updated_at: i64,
}

#[tauri::command]
pub fn get_collection_summary(app: AppHandle, kind: String, key: String) -> CmdResult<Option<CollectionSummary>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let row = db
        .query_row(
            "SELECT summary, updated_at FROM collection_summaries WHERE kind = ?1 AND key = ?2",
            params![kind, key],
            |r| {
                Ok(CollectionSummary {
                    summary: r.get(0)?,
                    updated_at: r.get(1)?,
                })
            },
        )
        .ok();
    Ok(row)
}

#[tauri::command]
pub async fn test_llm(app: AppHandle) -> CmdResult<String> {
    ai::chat(
        &app,
        "You are a connectivity test.",
        "Reply with the single word: OK",
        16,
    )
    .await
    .map_err(eanyhow)
}

#[tauri::command]
pub async fn download_model(app: AppHandle, repo: String) -> CmdResult<String> {
    ai::download_hf_model(&app, &repo).await.map_err(eanyhow)
}

// ---------------------------------------------------------------- settings & system

#[tauri::command]
pub fn get_settings(app: AppHandle) -> CmdResult<AppSettings> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    Ok(db::load_settings(&db))
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: AppSettings) -> CmdResult<()> {
    let needs_sidecar_restart = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let old = db::load_settings(&db);
        db::save_settings(&db, &settings).map_err(eanyhow)?;
        old.sidecar_binary != settings.sidecar_binary
            || old.model_path != settings.model_path
            || old.sidecar_port != settings.sidecar_port
            || (old.llm_backend == "sidecar" && settings.llm_backend != "sidecar")
    };
    if needs_sidecar_restart {
        ai::kill_sidecar(&app).await;
    }
    Ok(())
}

#[tauri::command]
pub fn reindex_all(app: AppHandle) -> CmdResult<QueueStatus> {
    let state = app.state::<AppState>();
    {
        let db = state.db.lock().unwrap();
        let rows: Vec<(String, String, String, Option<String>, Option<String>, bool)> = {
            let mut stmt = db
                .prepare(
                    "SELECT id, title, content, last_embed_input, last_llm_input,
                            (embedding IS NOT NULL) FROM notes",
                )
                .map_err(estr)?;
            let mapped = stmt
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map_err(estr)?;
            mapped.filter_map(|r| r.ok()).collect()
        };
        for (id, title, content, last_embed, last_llm, has_emb) in rows {
            let input = db::ai_input(&title, &content);
            if !has_emb || diff::significant_change(last_embed.as_deref(), &input) {
                db.execute(
                    "UPDATE notes SET embedding_status = 'STALE' WHERE id = ?1 AND embedding_status != 'PENDING'",
                    params![id],
                )
                .map_err(estr)?;
            }
            if diff::significant_change(last_llm.as_deref(), &input) {
                db.execute(
                    "UPDATE notes SET llm_status = 'STALE' WHERE id = ?1 AND llm_status != 'PENDING'",
                    params![id],
                )
                .map_err(estr)?;
            }
        }
    }
    state.sweep_active.store(true, Ordering::Relaxed);
    queue::queue_status(&app).map_err(eanyhow)
}

#[tauri::command]
pub fn queue_status(app: AppHandle) -> CmdResult<QueueStatus> {
    queue::queue_status(&app).map_err(eanyhow)
}

#[tauri::command]
pub fn notify_activity(app: AppHandle) -> CmdResult<()> {
    touch_activity(&app);
    Ok(())
}

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> CmdResult<String> {
    let dir = app.path().app_data_dir().map_err(estr)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_image(app: AppHandle, src_path: String) -> CmdResult<String> {
    let src = PathBuf::from(&src_path);
    if !src.is_file() {
        return Err(format!("Not a file: {src_path}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].contains(&e.as_str()))
        .ok_or_else(|| "Unsupported image type".to_string())?;
    let name = format!("{}.{ext}", Uuid::new_v4());
    let dir = app.path().app_data_dir().map_err(estr)?.join("images");
    std::fs::create_dir_all(&dir).map_err(estr)?;
    std::fs::copy(&src, dir.join(&name)).map_err(estr)?;
    Ok(format!("images/{name}"))
}

// ---------------------------------------------------------------- export

fn sanitize_filename(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    let out: String = trimmed.chars().take(80).collect();
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(|| ms.to_string())
}

#[tauri::command]
pub fn export_notes(app: AppHandle, dest: String, format: String) -> CmdResult<i64> {
    let state = app.state::<AppState>();
    let dest = PathBuf::from(dest);
    std::fs::create_dir_all(&dest).map_err(estr)?;

    let (folders, notes) = {
        let db = state.db.lock().unwrap();
        (
            db::list_folders(&db).map_err(eanyhow)?,
            db::list_notes(&db, None, None).map_err(eanyhow)?,
        )
    };

    // Copy embedded images alongside the export so relative links keep working.
    let images_src = app.path().app_data_dir().map_err(estr)?.join("images");
    if images_src.is_dir() {
        let images_dest = dest.join("images");
        std::fs::create_dir_all(&images_dest).map_err(estr)?;
        if let Ok(entries) = std::fs::read_dir(&images_src) {
            for entry in entries.flatten() {
                if entry.path().is_file() {
                    let _ = std::fs::copy(entry.path(), images_dest.join(entry.file_name()));
                }
            }
        }
    }

    let count = notes.len() as i64;

    if format == "json" {
        let payload = serde_json::json!({
            "exported_at": iso(now_ms()),
            "app": "NexusNote",
            "folders": folders,
            "notes": notes.iter().map(|n| serde_json::json!({
                "id": n.id,
                "title": n.title,
                "content": n.content,
                "folder_id": n.folder_id,
                "tags": n.tags,
                "created_at": iso(n.created_at),
                "updated_at": iso(n.updated_at),
            })).collect::<Vec<_>>(),
        });
        std::fs::write(
            dest.join("nexusnote-export.json"),
            serde_json::to_string_pretty(&payload).map_err(estr)?,
        )
        .map_err(estr)?;
        return Ok(count);
    }

    // Markdown export: mirror the folder hierarchy on disk.
    let by_id: HashMap<&str, &Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut folder_paths: HashMap<String, PathBuf> = HashMap::new();
    for f in &folders {
        let mut parts = vec![sanitize_filename(&f.name)];
        let mut cur = f.parent_id.as_deref();
        let mut guard = 0;
        while let Some(pid) = cur {
            guard += 1;
            if guard > 64 {
                break;
            }
            match by_id.get(pid) {
                Some(p) => {
                    parts.push(sanitize_filename(&p.name));
                    cur = p.parent_id.as_deref();
                }
                None => break,
            }
        }
        parts.reverse();
        folder_paths.insert(f.id.clone(), parts.iter().collect());
    }

    let notes_root = dest.join("notes");
    let mut used: HashSet<PathBuf> = HashSet::new();
    for n in &notes {
        let dir = match n.folder_id.as_ref().and_then(|f| folder_paths.get(f)) {
            Some(rel) => notes_root.join(rel),
            None => notes_root.clone(),
        };
        std::fs::create_dir_all(&dir).map_err(estr)?;

        let base = sanitize_filename(if n.title.is_empty() { "untitled" } else { &n.title });
        let mut path = dir.join(format!("{base}.md"));
        let mut i = 1;
        while used.contains(&path) || path.exists() {
            path = dir.join(format!("{base}-{i}.md"));
            i += 1;
        }
        used.insert(path.clone());

        let tags = n
            .tags
            .iter()
            .map(|t| t.tag.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let body = format!(
            "---\ntitle: \"{}\"\ntags: [{}]\ncreated: {}\nupdated: {}\n---\n\n{}\n",
            n.title.replace('"', "'"),
            tags,
            iso(n.created_at),
            iso(n.updated_at),
            n.content
        );
        std::fs::write(&path, body).map_err(estr)?;
    }
    Ok(count)
}
