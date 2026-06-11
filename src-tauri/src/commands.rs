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
use crate::models::{ActionItem, AppSettings, Folder, Note, QueueStatus, TagCount};
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
pub async fn create_note(app: AppHandle, folder_id: Option<String>) -> CmdResult<Note> {
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
pub async fn get_note(app: AppHandle, id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::get_note(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub async fn update_note(app: AppHandle, id: String, title: String, content: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let old = db::get_note(&db, &id).map_err(eanyhow)?;
    let now = now_ms();
    state.last_activity.store(now, Ordering::Relaxed);

    if old.title != title || old.content != content {
        // Checkpoint the pre-edit state (rate-limited inside the helper).
        db::maybe_snapshot_note(&db, &id, &old.title, &old.content).map_err(eanyhow)?;
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

/// Soft delete: the note moves to Trash and drops out of every list/query.
#[tauri::command]
pub async fn delete_note(app: AppHandle, id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE notes SET deleted_at = ?1, pinned = 0 WHERE id = ?2",
        params![now_ms(), id],
    )
    .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub async fn restore_note(app: AppHandle, id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("UPDATE notes SET deleted_at = NULL WHERE id = ?1", params![id])
        .map_err(estr)?;
    db::get_note(&db, &id).map_err(eanyhow)
}

/// Permanently delete one trashed note.
#[tauri::command]
pub async fn purge_note(app: AppHandle, id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )
    .map_err(estr)?;
    Ok(())
}

/// Permanently delete everything in the trash; returns how many were purged.
#[tauri::command]
pub async fn empty_trash(app: AppHandle) -> CmdResult<i64> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let n = db
        .execute("DELETE FROM notes WHERE deleted_at IS NOT NULL", [])
        .map_err(estr)?;
    Ok(n as i64)
}

#[tauri::command]
pub async fn list_trashed_notes(app: AppHandle) -> CmdResult<Vec<Note>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_trashed(&db).map_err(eanyhow)
}

#[tauri::command]
pub async fn move_note(app: AppHandle, id: String, folder_id: Option<String>) -> CmdResult<Note> {
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
pub async fn set_note_pinned(app: AppHandle, id: String, pinned: bool) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE notes SET pinned = ?1 WHERE id = ?2",
        params![pinned, id],
    )
    .map_err(estr)?;
    db::get_note(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub async fn add_tag(app: AppHandle, note_id: String, tag: String) -> CmdResult<Note> {
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
pub async fn remove_tag(app: AppHandle, note_id: String, tag: String) -> CmdResult<Note> {
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
pub async fn accept_folder_suggestion(app: AppHandle, note_id: String) -> CmdResult<Note> {
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
pub async fn dismiss_folder_suggestion(app: AppHandle, note_id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE notes SET suggested_folder_id = NULL WHERE id = ?1",
        params![note_id],
    )
    .map_err(estr)?;
    db::get_note(&db, &note_id).map_err(eanyhow)
}

/// List rows carry a content *excerpt* only — the editor loads the full note
/// through `get_note`.
#[tauri::command]
pub async fn list_notes(
    app: AppHandle,
    folder_id: Option<String>,
    tags: Option<Vec<String>>,
) -> CmdResult<Vec<Note>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_notes(&db, folder_id.as_deref(), tags.as_deref(), true).map_err(eanyhow)
}

// ---------------------------------------------------------------- search

fn fts_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// bm25-ranked FTS5 hits, best first: (note id, highlighted snippet, bm25).
fn keyword_ranked(
    db: &rusqlite::Connection,
    q: &str,
    limit: usize,
) -> CmdResult<Vec<(String, String, f64)>> {
    let match_q = fts_query(q);
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
             WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
             ORDER BY bm25(notes_fts)
             LIMIT ?2",
        )
        .map_err(estr)?;
    let rows = stmt
        .query_map(params![match_q, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(estr)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

const SEMANTIC_TOP: usize = 30;

/// Cosine-ranked semantic hits, best first. Embeds the query on the blocking
/// pool, then scans all stored vectors in-process. The similarity floor comes
/// from settings (`semantic_search_threshold`, default 0.25).
async fn semantic_ranked(app: &AppHandle, q: &str) -> CmdResult<Vec<(String, f32)>> {
    let vectors = embed::embed_texts(app.clone(), vec![q.to_string()])
        .await
        .map_err(eanyhow)?;
    let qv = vectors
        .into_iter()
        .next()
        .ok_or_else(|| "embedding failed".to_string())?;

    let state = app.state::<AppState>();
    let (threshold, mut scored): (f32, Vec<(String, f32)>) = {
        let db = state.db.lock().unwrap();
        let threshold = db::load_settings(&db).semantic_search_threshold.clamp(0.0, 1.0);
        let mut stmt = db
            .prepare(
                "SELECT id, embedding FROM notes
                 WHERE embedding IS NOT NULL AND deleted_at IS NULL",
            )
            .map_err(estr)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(estr)?;
        let scored = rows
            .filter_map(|r| r.ok())
            .map(|(id, blob)| {
                let score = embed::cosine(&qv, &embed::from_blob(&blob));
                (id, score)
            })
            .collect();
        (threshold, scored)
    };
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.retain(|(_, s)| *s > threshold);
    scored.truncate(SEMANTIC_TOP);
    Ok(scored)
}

#[tauri::command]
pub async fn search_notes(app: AppHandle, query: String, mode: String) -> CmdResult<Vec<Note>> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let state = app.state::<AppState>();

    if mode == "semantic" {
        let scored = semantic_ranked(&app, &q).await?;
        let ids: Vec<String> = scored.iter().map(|(id, _)| id.clone()).collect();
        let db = state.db.lock().unwrap();
        let mut notes = db::get_notes_by_ids(&db, &ids).map_err(eanyhow)?;
        let score_map: HashMap<&str, f32> = scored.iter().map(|(id, s)| (id.as_str(), *s)).collect();
        for n in notes.iter_mut() {
            n.score = score_map.get(n.id.as_str()).copied();
        }
        Ok(notes)
    } else if mode == "keyword" {
        let db = state.db.lock().unwrap();
        let rows = keyword_ranked(&db, &q, 50)?;
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
    } else {
        // "smart" (the default): run both engines and fuse the rankings with
        // Reciprocal Rank Fusion — score(note) = Σ 1/(k + rank), k = 60 (the
        // standard constant). Rank-based fusion sidesteps the incomparable
        // scales of bm25 and cosine. The semantic leg is skipped until the
        // embedder is READY, so a search never waits on a model download —
        // it degrades to plain keyword results.
        const RRF_K: f32 = 60.0;

        let kw: Vec<(String, String, f64)> = {
            let db = state.db.lock().unwrap();
            keyword_ranked(&db, &q, 50)?
        };
        let embedder_ready = state.embedder_phase.load(Ordering::Relaxed)
            == crate::state::embedder_phase::READY;
        let sem: Vec<(String, f32)> = if embedder_ready {
            match semantic_ranked(&app, &q).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[search] semantic leg failed, keyword-only: {e}");
                    vec![]
                }
            }
        } else {
            vec![]
        };

        #[derive(Default)]
        struct Fused {
            score: f32,
            snippet: Option<String>,
            kw: bool,
            sem: bool,
        }
        let mut fused: HashMap<String, Fused> = HashMap::new();
        for (i, (id, snip, _)) in kw.iter().enumerate() {
            let e = fused.entry(id.clone()).or_default();
            e.score += 1.0 / (RRF_K + (i + 1) as f32);
            e.snippet = Some(snip.clone());
            e.kw = true;
        }
        for (i, (id, _)) in sem.iter().enumerate() {
            let e = fused.entry(id.clone()).or_default();
            e.score += 1.0 / (RRF_K + (i + 1) as f32);
            e.sem = true;
        }

        let mut ranked: Vec<(String, Fused)> = fused.into_iter().collect();
        ranked.sort_by(|a, b| b.1.score.partial_cmp(&a.1.score).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(50);

        let ids: Vec<String> = ranked.iter().map(|(id, _)| id.clone()).collect();
        let db = state.db.lock().unwrap();
        let mut notes = db::get_notes_by_ids(&db, &ids).map_err(eanyhow)?;
        let meta: HashMap<&str, &Fused> = ranked.iter().map(|(id, f)| (id.as_str(), f)).collect();
        for n in notes.iter_mut() {
            if let Some(f) = meta.get(n.id.as_str()) {
                n.snippet = f.snippet.clone();
                // RRF scores aren't human-meaningful — expose provenance
                // instead (the UI badges semantic-only matches).
                n.matched_by = Some(
                    match (f.kw, f.sem) {
                        (true, true) => "both",
                        (false, true) => "semantic",
                        _ => "keyword",
                    }
                    .to_string(),
                );
            }
        }
        Ok(notes)
    }
}

/// Most similar notes to the given one, by embedding cosine similarity.
#[tauri::command]
pub async fn related_notes(app: AppHandle, note_id: String) -> CmdResult<Vec<Note>> {
    let state = app.state::<AppState>();
    let (threshold, scored): (f32, Vec<(String, f32)>) = {
        let db = state.db.lock().unwrap();
        let threshold = db::load_settings(&db).related_notes_threshold.clamp(0.0, 1.0);
        let target: Option<Vec<u8>> = db
            .query_row(
                "SELECT embedding FROM notes WHERE id = ?1",
                params![note_id],
                |r| r.get(0),
            )
            .map_err(estr)?;
        let Some(target) = target else {
            return Ok(vec![]); // not embedded yet — the panel just stays hidden
        };
        let qv = embed::from_blob(&target);
        let mut stmt = db
            .prepare(
                "SELECT id, embedding FROM notes
                 WHERE embedding IS NOT NULL AND deleted_at IS NULL AND id != ?1",
            )
            .map_err(estr)?;
        let rows = stmt
            .query_map(params![note_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(estr)?;
        let scored = rows
            .filter_map(|r| r.ok())
            .map(|(id, blob)| {
                let score = embed::cosine(&qv, &embed::from_blob(&blob));
                (id, score)
            })
            .collect();
        (threshold, scored)
    };
    let mut scored = scored;
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.retain(|(_, s)| *s > threshold);
    scored.truncate(4);

    let ids: Vec<String> = scored.iter().map(|(id, _)| id.clone()).collect();
    let db = state.db.lock().unwrap();
    let mut notes = db::get_notes_by_ids(&db, &ids).map_err(eanyhow)?;
    let score_map: HashMap<&str, f32> = scored.iter().map(|(id, s)| (id.as_str(), *s)).collect();
    for n in notes.iter_mut() {
        n.score = score_map.get(n.id.as_str()).copied();
    }
    Ok(notes)
}

// ---------------------------------------------------------------- similar notes

fn uf_find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Clusters of highly similar notes (embedding cosine above the tunable
/// `similar_merge_threshold`, default 0.80), candidates for merging. Groups
/// are oldest-first; capped to keep the review digestible.
#[tauri::command]
pub async fn find_similar_notes(app: AppHandle) -> CmdResult<Vec<Vec<Note>>> {
    const MAX_GROUPS: usize = 10;
    const MAX_GROUP_SIZE: usize = 6;

    let state = app.state::<AppState>();
    let (threshold, ids, vecs): (f32, Vec<String>, Vec<Vec<f32>>) = {
        let db = state.db.lock().unwrap();
        let threshold = db::load_settings(&db).similar_merge_threshold.clamp(0.0, 1.0);
        let mut stmt = db
            .prepare(
                "SELECT id, embedding FROM notes
                 WHERE embedding IS NOT NULL AND deleted_at IS NULL",
            )
            .map_err(estr)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(estr)?;
        let mut ids = Vec::new();
        let mut vecs = Vec::new();
        for row in rows.filter_map(|r| r.ok()) {
            ids.push(row.0);
            vecs.push(embed::from_blob(&row.1));
        }
        (threshold, ids, vecs)
    };

    let n = ids.len();
    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        for j in (i + 1)..n {
            if embed::cosine(&vecs[i], &vecs[j]) >= threshold {
                let (ri, rj) = (uf_find(&mut parent, i), uf_find(&mut parent, j));
                if ri != rj {
                    parent[rj] = ri;
                }
            }
        }
    }

    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let root = uf_find(&mut parent, i);
        clusters.entry(root).or_default().push(i);
    }

    let db = state.db.lock().unwrap();
    let mut groups: Vec<Vec<Note>> = Vec::new();
    for members in clusters.into_values() {
        if members.len() < 2 {
            continue;
        }
        let member_ids: Vec<String> = members
            .into_iter()
            .take(MAX_GROUP_SIZE)
            .map(|i| ids[i].clone())
            .collect();
        let mut notes = db::get_notes_by_ids(&db, &member_ids).map_err(eanyhow)?;
        notes.sort_by_key(|n| n.created_at);
        groups.push(notes);
    }
    // Biggest clusters first — they're the most worth cleaning up.
    groups.sort_by_key(|g| std::cmp::Reverse(g.len()));
    groups.truncate(MAX_GROUPS);
    Ok(groups)
}

fn concat_notes(notes: &[Note]) -> String {
    notes
        .iter()
        .map(|n| {
            let title = if n.title.trim().is_empty() { "Untitled" } else { n.title.trim() };
            format!("## {}\n\n{}", title, n.content.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

/// Merge the given notes into the oldest one: content combined (LLM when
/// available, plain concatenation otherwise), tags unioned, action items
/// re-linked, the other notes moved to Trash. Fully recoverable: the target
/// is version-snapshotted and the sources sit in Trash for 30 days.
#[tauri::command]
pub async fn merge_notes(app: AppHandle, note_ids: Vec<String>) -> CmdResult<Note> {
    if note_ids.len() < 2 {
        return Err("Select at least two notes to merge".into());
    }
    let (notes, llm_ready) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let mut notes = Vec::new();
        for id in &note_ids {
            if let Ok(n) = db::get_note(&db, id) {
                if n.deleted_at.is_none() {
                    notes.push(n);
                }
            }
        }
        (notes, db::load_settings(&db).llm_backend != "none")
    };
    if notes.len() < 2 {
        return Err("These notes are no longer available".into());
    }

    let target = notes.iter().min_by_key(|n| n.created_at).unwrap().clone();

    queue::set_activity(
        &app,
        Some((format!("Merging {} similar notes…", notes.len()), Some(target.id.clone()))),
    );
    let merged_content = if llm_ready {
        match ai::merge_notes_text(&app, &notes).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[merge] LLM merge failed, falling back to concat: {e:#}");
                concat_notes(&notes)
            }
        }
    } else {
        concat_notes(&notes)
    };
    queue::set_activity(&app, None);

    let title = if target.title.trim().is_empty() {
        notes
            .iter()
            .map(|n| n.title.trim())
            .find(|t| !t.is_empty())
            .unwrap_or("")
            .to_string()
    } else {
        target.title.clone()
    };

    let now = now_ms();
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::snapshot_note(&db, &target.id, &target.title, &target.content).map_err(eanyhow)?;
    db.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3,
                embedding_status = 'STALE', llm_status = 'STALE'
         WHERE id = ?4",
        params![title, merged_content, now, target.id],
    )
    .map_err(estr)?;
    for n in &notes {
        if n.id == target.id {
            continue;
        }
        db.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag, source)
             SELECT ?1, tag, source FROM note_tags WHERE note_id = ?2",
            params![target.id, n.id],
        )
        .map_err(estr)?;
        db.execute(
            "UPDATE action_items SET note_id = ?1 WHERE note_id = ?2",
            params![target.id, n.id],
        )
        .map_err(estr)?;
        db.execute(
            "UPDATE notes SET deleted_at = ?1, pinned = 0 WHERE id = ?2",
            params![now, n.id],
        )
        .map_err(estr)?;
    }
    let note = db::get_note(&db, &target.id).map_err(eanyhow)?;
    let _ = app.emit("note-updated", &note);
    let _ = app.emit("action-items-changed", ());
    Ok(note)
}

// ---------------------------------------------------------------- folders & tags

#[tauri::command]
pub async fn list_folders(app: AppHandle) -> CmdResult<Vec<Folder>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_folders(&db).map_err(eanyhow)
}

#[tauri::command]
pub async fn create_folder(app: AppHandle, name: String, parent_id: Option<String>) -> CmdResult<Folder> {
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

/// Re-parent a folder (None = root). Refuses moves into the folder's own subtree.
#[tauri::command]
pub async fn move_folder(app: AppHandle, id: String, parent_id: Option<String>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    if let Some(pid) = &parent_id {
        let subtree = db::folder_with_descendants(&db, &id).map_err(eanyhow)?;
        if subtree.contains(pid) {
            return Err("Can't move a folder inside itself".into());
        }
    }
    db.execute(
        "UPDATE folders SET parent_id = ?1 WHERE id = ?2",
        params![parent_id, id],
    )
    .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub async fn rename_folder(app: AppHandle, id: String, name: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("UPDATE folders SET name = ?1 WHERE id = ?2", params![name.trim(), id])
        .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_folder(app: AppHandle, id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(estr)?;
    Ok(())
}

#[tauri::command]
pub async fn list_tags(app: AppHandle) -> CmdResult<Vec<TagCount>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_tags(&db).map_err(eanyhow)
}

/// Remove a tag from every note that carries it (and its cached summary).
#[tauri::command]
pub async fn delete_tag(app: AppHandle, tag: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM note_tags WHERE tag = ?1", params![tag])
        .map_err(estr)?;
    db.execute(
        "DELETE FROM collection_summaries WHERE kind = 'tag' AND key = ?1",
        params![tag],
    )
    .map_err(estr)?;
    Ok(())
}

// ---------------------------------------------------------------- AI actions

#[tauri::command]
pub async fn ai_process_note(app: AppHandle, note_id: String) -> CmdResult<Note> {
    let untitled = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.execute("UPDATE notes SET llm_status = 'PENDING' WHERE id = ?1", params![note_id])
            .map_err(estr)?;
        let title: String = db
            .query_row("SELECT title FROM notes WHERE id = ?1", params![note_id], |r| r.get(0))
            .map_err(estr)?;
        title.trim().is_empty() && db::load_settings(&db).auto_title
    };
    if untitled {
        if let Err(e) = ai::generate_title(&app, &note_id).await {
            eprintln!("[title] generation failed for {note_id}: {e:#}");
        }
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

/// Generate titles for every untitled note that has content, sequentially,
/// publishing live progress through the worker activity label. Returns how
/// many notes were titled; stops at the first LLM error (it's systemic).
#[tauri::command]
pub async fn ai_title_untitled(app: AppHandle) -> CmdResult<i64> {
    let ids: Vec<String> = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id FROM notes
                 WHERE TRIM(title) = '' AND TRIM(content) != '' AND deleted_at IS NULL
                 ORDER BY updated_at DESC",
            )
            .map_err(estr)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(estr)?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let total = ids.len();
    let mut titled = 0i64;
    for (i, id) in ids.iter().enumerate() {
        queue::set_activity(
            &app,
            Some((format!("Titling untitled notes ({}/{total})…", i + 1), Some(id.clone()))),
        );
        match ai::generate_title(&app, id).await {
            Ok(note) => {
                if !note.title.trim().is_empty() {
                    titled += 1;
                }
                let _ = app.emit("note-updated", note);
            }
            Err(e) => {
                queue::set_activity(&app, None);
                return Err(format!("Stopped after {titled} of {total}: {e:#}"));
            }
        }
    }
    queue::set_activity(&app, None);
    Ok(titled)
}

/// Re-run the organize pipeline (AI tags + folder suggestion) over every
/// note with content, sequentially, with live progress. AI tags are wiped
/// and rewritten per note; manual tags are never touched. Returns how many
/// notes were processed; stops at the first LLM error (it's systemic).
#[tauri::command]
pub async fn ai_retag_all(app: AppHandle) -> CmdResult<i64> {
    let notes: Vec<(String, String)> = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id, title FROM notes
                 WHERE TRIM(content) != '' AND deleted_at IS NULL
                 ORDER BY updated_at DESC",
            )
            .map_err(estr)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(estr)?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let total = notes.len();
    let mut done = 0i64;
    for (i, (id, title)) in notes.iter().enumerate() {
        let label = if title.trim().is_empty() { "Untitled" } else { title.trim() };
        queue::set_activity(
            &app,
            Some((
                format!("Re-tagging “{label}” ({}/{total})…", i + 1),
                Some(id.clone()),
            )),
        );
        match ai::auto_tag_and_route(&app, id).await {
            Ok(note) => {
                done += 1;
                let _ = app.emit("note-updated", note);
            }
            Err(e) => {
                queue::set_activity(&app, None);
                return Err(format!("Stopped after {done} of {total}: {e:#}"));
            }
        }
    }
    queue::set_activity(&app, None);
    Ok(done)
}

/// Propose a bullet-point rewrite of the note. Returns the proposed markdown
/// only; the user reviews it in a keep/discard preview before anything is
/// written (`apply_note_rewrite`).
#[tauri::command]
pub async fn ai_bulletify_preview(app: AppHandle, note_id: String) -> CmdResult<String> {
    ai::bulletify(&app, &note_id).await.map_err(eanyhow)
}

/// Apply an LLM-proposed rewrite the user accepted in a preview. Always
/// checkpoints the pre-rewrite state first (snapshot-before-AI-rewrites rule),
/// so even an accepted rewrite stays recoverable from History.
#[tauri::command]
pub async fn apply_note_rewrite(app: AppHandle, note_id: String, content: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let before = db::get_note(&db, &note_id).map_err(eanyhow)?;
    db::snapshot_note(&db, &note_id, &before.title, &before.content).map_err(eanyhow)?;
    db.execute(
        "UPDATE notes SET content = ?1, updated_at = ?2,
                embedding_status = 'STALE', llm_status = 'STALE'
         WHERE id = ?3",
        params![content, now_ms(), note_id],
    )
    .map_err(estr)?;
    state.last_activity.store(now_ms(), Ordering::Relaxed);
    let note = db::get_note(&db, &note_id).map_err(eanyhow)?;
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
pub async fn get_collection_summary(app: AppHandle, kind: String, key: String) -> CmdResult<Option<CollectionSummary>> {
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
        None,
    )
    .await
    .map_err(eanyhow)
}

#[tauri::command]
pub async fn download_model(app: AppHandle, repo: String) -> CmdResult<String> {
    ai::download_hf_model(&app, &repo).await.map_err(eanyhow)
}

// ---------------------------------------------------------------- action items

#[tauri::command]
pub async fn list_action_items(app: AppHandle) -> CmdResult<Vec<ActionItem>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_action_items(&db).map_err(eanyhow)
}

/// Manually run extraction for one note; returns the resulting proposals.
#[tauri::command]
pub async fn extract_actions_note(app: AppHandle, note_id: String) -> CmdResult<Vec<ActionItem>> {
    ai::extract_actions(&app, &note_id).await.map_err(eanyhow)
}

/// Manually add an action item (goes straight to `scheduled`).
#[tauri::command]
pub async fn create_action_item(
    app: AppHandle,
    text: String,
    category: Option<String>,
    due_at: Option<i64>,
    note_id: Option<String>,
) -> CmdResult<ActionItem> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Action text is empty".into());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let category = category
        .map(|c| c.trim().to_lowercase())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "general".to_string());
    db.execute(
        "INSERT INTO action_items(id, note_id, text, category, status, due_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'scheduled', ?5, ?6, ?6)",
        params![id, note_id, text, category, due_at, now],
    )
    .map_err(estr)?;
    let _ = app.emit("action-items-changed", ());
    db::get_action_item(&db, &id).map_err(eanyhow)
}

/// Accept / complete / dismiss an item.
#[tauri::command]
pub async fn set_action_status(app: AppHandle, id: String, status: String) -> CmdResult<ActionItem> {
    if !["proposed", "scheduled", "done", "dismissed"].contains(&status.as_str()) {
        return Err(format!("Invalid status: {status}"));
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE action_items SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, now_ms(), id],
    )
    .map_err(estr)?;
    let _ = app.emit("action-items-changed", ());
    db::get_action_item(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub async fn set_action_category(app: AppHandle, id: String, category: String) -> CmdResult<ActionItem> {
    let category = category.trim().to_lowercase();
    if category.is_empty() {
        return Err("Category is empty".into());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE action_items SET category = ?1, updated_at = ?2 WHERE id = ?3",
        params![category, now_ms(), id],
    )
    .map_err(estr)?;
    let _ = app.emit("action-items-changed", ());
    db::get_action_item(&db, &id).map_err(eanyhow)
}

/// Set or clear the due time. Changing it re-arms the notification.
#[tauri::command]
pub async fn set_action_due(app: AppHandle, id: String, due_at: Option<i64>) -> CmdResult<ActionItem> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE action_items SET due_at = ?1, notified_at = NULL, updated_at = ?2 WHERE id = ?3",
        params![due_at, now_ms(), id],
    )
    .map_err(estr)?;
    let _ = app.emit("action-items-changed", ());
    db::get_action_item(&db, &id).map_err(eanyhow)
}

#[tauri::command]
pub async fn delete_action_item(app: AppHandle, id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM action_items WHERE id = ?1", params![id])
        .map_err(estr)?;
    let _ = app.emit("action-items-changed", ());
    Ok(())
}

// ---------------------------------------------------------------- settings & system

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> CmdResult<AppSettings> {
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
pub async fn reindex_all(app: AppHandle) -> CmdResult<QueueStatus> {
    let state = app.state::<AppState>();
    {
        let db = state.db.lock().unwrap();
        let rows: Vec<(String, String, String, Option<String>, Option<String>, bool)> = {
            let mut stmt = db
                .prepare(
                    "SELECT id, title, content, last_embed_input, last_llm_input,
                            (embedding IS NOT NULL) FROM notes WHERE deleted_at IS NULL",
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

// Async on purpose: sync commands run on the main thread, and status must
// never make the UI wait behind the worker's locks.
#[tauri::command]
pub async fn queue_status(app: AppHandle) -> CmdResult<QueueStatus> {
    queue::queue_status(&app).map_err(eanyhow)
}

/// Notes still waiting for (or currently in) the embedding / LLM pipelines.
#[tauri::command]
pub async fn list_queued_notes(app: AppHandle) -> CmdResult<Vec<Note>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let ids: Vec<String> = {
        let mut stmt = db
            .prepare(
                "SELECT id FROM notes
                 WHERE deleted_at IS NULL
                   AND (embedding_status != 'CLEAN' OR llm_status != 'CLEAN')
                 ORDER BY updated_at DESC LIMIT 200",
            )
            .map_err(estr)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(estr)?;
        rows.filter_map(|r| r.ok()).collect()
    };
    db::get_notes_by_ids(&db, &ids).map_err(eanyhow)
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
pub async fn save_image(app: AppHandle, src_path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
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
    })
    .await
    .map_err(estr)?
}

// ---------------------------------------------------------------- versions

#[tauri::command]
pub async fn list_note_versions(
    app: AppHandle,
    note_id: String,
) -> CmdResult<Vec<crate::models::NoteVersionMeta>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT id, note_id, title, content, created_at FROM note_versions
             WHERE note_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(estr)?;
    let rows = stmt
        .query_map(params![note_id], |r| {
            let content: String = r.get(3)?;
            Ok(crate::models::NoteVersionMeta {
                id: r.get(0)?,
                note_id: r.get(1)?,
                title: r.get(2)?,
                preview: content.chars().take(160).collect(),
                chars: content.chars().count() as i64,
                created_at: r.get(4)?,
            })
        })
        .map_err(estr)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Replace the note's content with a stored version (snapshotting the
/// current state first, so a restore is itself undoable).
#[tauri::command]
pub async fn restore_note_version(app: AppHandle, version_id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let (note_id, title, content): (String, String, String) = db
        .query_row(
            "SELECT note_id, title, content FROM note_versions WHERE id = ?1",
            params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(estr)?;
    let current = db::get_note(&db, &note_id).map_err(eanyhow)?;
    db::snapshot_note(&db, &note_id, &current.title, &current.content).map_err(eanyhow)?;
    db.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3,
                embedding_status = 'STALE', llm_status = 'STALE'
         WHERE id = ?4",
        params![title, content, now_ms(), note_id],
    )
    .map_err(estr)?;
    let note = db::get_note(&db, &note_id).map_err(eanyhow)?;
    let _ = app.emit("note-updated", &note);
    Ok(note)
}

/// Save pasted image data (base64) into app storage; returns the relative
/// path. Decoding + writing happen on the blocking pool — pasted screenshots
/// can be multi-MB.
#[tauri::command]
pub async fn save_image_bytes(app: AppHandle, data_base64: String, ext: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
        use base64::Engine;
        let ext = ext.to_lowercase();
        if !["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].contains(&ext.as_str()) {
            return Err("Unsupported image type".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.as_bytes())
            .map_err(estr)?;
        if bytes.is_empty() {
            return Err("Empty image data".into());
        }
        let name = format!("{}.{ext}", Uuid::new_v4());
        let dir = app.path().app_data_dir().map_err(estr)?.join("images");
        std::fs::create_dir_all(&dir).map_err(estr)?;
        std::fs::write(dir.join(&name), &bytes).map_err(estr)?;
        Ok(format!("images/{name}"))
    })
    .await
    .map_err(estr)?
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
pub async fn export_notes(app: AppHandle, dest: String, format: String) -> CmdResult<i64> {
    tauri::async_runtime::spawn_blocking(move || export_notes_core(&app, PathBuf::from(dest), &format))
        .await
        .map_err(estr)?
}

#[derive(Serialize, Clone)]
pub struct BackupResult {
    pub count: i64,
    pub path: String,
}

/// Markdown backup into the configured folder (timestamped subdir);
/// records `last_backup_at` so the worker knows when the next one is due.
pub fn run_backup(app: &AppHandle) -> Result<BackupResult, String> {
    let dir = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        db::load_settings(&db).backup_dir
    };
    if dir.trim().is_empty() {
        return Err("No backup folder configured in Settings".into());
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let dest = PathBuf::from(dir.trim()).join(format!("goldfishy-backup-{stamp}"));
    let count = export_notes_core(app, dest.clone(), "markdown")?;
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO settings(key, value) VALUES ('last_backup_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now_ms().to_string()],
    )
    .map_err(estr)?;
    Ok(BackupResult {
        count,
        path: dest.display().to_string(),
    })
}

#[tauri::command]
pub async fn backup_now(app: AppHandle) -> CmdResult<BackupResult> {
    tauri::async_runtime::spawn_blocking(move || run_backup(&app))
        .await
        .map_err(estr)?
}

pub fn export_notes_core(app: &AppHandle, dest: PathBuf, format: &str) -> CmdResult<i64> {
    let state = app.state::<AppState>();
    std::fs::create_dir_all(&dest).map_err(estr)?;

    let (folders, notes) = {
        let db = state.db.lock().unwrap();
        (
            db::list_folders(&db).map_err(eanyhow)?,
            // Full content — this is the export.
            db::list_notes(&db, None, None, false).map_err(eanyhow)?,
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
            "app": "GoldFishy",
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
            dest.join("goldfishy-export.json"),
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
