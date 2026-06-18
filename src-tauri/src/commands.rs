use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::ai;
use crate::db::{self, now_ms};
use crate::diff;
use crate::embed;
use crate::models::{
    ActionItem, AppSettings, ArrangeGroup, ArrangeMove, BoardCluster, BoardData, Folder,
    ImportResult, Note, QueueStatus, Sticky, TagCount,
};
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

/// bm25-ranked sticky FTS hits: (sticky id, highlighted snippet, bm25).
fn sticky_keyword_ranked(
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
            "SELECT s.id,
                    snippet(stickies_fts, 0, '<mark>', '</mark>', ' … ', 12),
                    bm25(stickies_fts)
             FROM stickies_fts
             JOIN stickies s ON s.rowid = stickies_fts.rowid
             WHERE stickies_fts MATCH ?1
             ORDER BY bm25(stickies_fts)
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

/// Cosine-ranked sticky hits over text-sticky embeddings, best first.
async fn sticky_semantic_ranked(app: &AppHandle, q: &str) -> CmdResult<Vec<(String, f32)>> {
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
                "SELECT id, embedding FROM stickies
                 WHERE embedding IS NOT NULL AND note_id IS NULL",
            )
            .map_err(estr)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .map_err(estr)?;
        let scored = rows
            .filter_map(|r| r.ok())
            .map(|(id, blob)| (id, embed::cosine(&qv, &embed::from_blob(&blob))))
            .collect();
        (threshold, scored)
    };
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.retain(|(_, s)| *s > threshold);
    scored.truncate(SEMANTIC_TOP);
    Ok(scored)
}

/// Search stickies — same keyword / semantic / smart modes as notes, surfaced
/// as a small group above the note results so a thought is never unfindable.
#[tauri::command]
pub async fn search_stickies(app: AppHandle, query: String, mode: String) -> CmdResult<Vec<Sticky>> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let state = app.state::<AppState>();

    // Collect (id, snippet, matched_by) with a fused rank, then hydrate.
    let kw: Vec<(String, String, f64)> = if mode == "semantic" {
        vec![]
    } else {
        let db = state.db.lock().unwrap();
        sticky_keyword_ranked(&db, &q, 30)?
    };
    let embedder_ready =
        state.embedder_phase.load(Ordering::Relaxed) == crate::state::embedder_phase::READY;
    let sem: Vec<(String, f32)> = if mode != "keyword" && embedder_ready {
        sticky_semantic_ranked(&app, &q).await.unwrap_or_default()
    } else {
        vec![]
    };

    const RRF_K: f32 = 60.0;
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
    ranked.truncate(20);

    let db = state.db.lock().unwrap();
    let mut out = Vec::new();
    for (id, f) in ranked {
        if let Ok(mut s) = db::get_sticky(&db, &id) {
            s.snippet = f.snippet;
            s.score = Some(f.score);
            s.matched_by = Some(
                match (f.kw, f.sem) {
                    (true, true) => "both",
                    (false, true) => "semantic",
                    _ => "keyword",
                }
                .to_string(),
            );
            out.push(s);
        }
    }
    Ok(out)
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

// ---------------------------------------------------------------- board

/// Working set: the board never renders more than this many notes, so the
/// O(n²) cosine pass and the card grid both stay cheap.
const BOARD_CAP: usize = 400;

/// Hand-ranked notes first (ascending rank), everything else behind them in
/// recency order — so a group the user arranged stays arranged while new
/// arrivals append below.
fn sort_board_notes(notes: &mut [Note], ranks: &HashMap<String, f64>) {
    notes.sort_by(|a, b| match (ranks.get(&a.id), ranks.get(&b.id)) {
        (Some(ra), Some(rb)) => ra.partial_cmp(rb).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.updated_at.cmp(&a.updated_at),
    });
}

/// Persist a hand ordering of Board cards: rank = position in `note_ids`.
/// The frontend sends the full new order of one group after a drop.
#[tauri::command]
pub async fn set_board_order(app: AppHandle, note_ids: Vec<String>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let now = now_ms();
    for (i, id) in note_ids.iter().enumerate() {
        db.execute(
            "INSERT INTO board_order(note_id, rank, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(note_id) DO UPDATE SET rank = excluded.rank,
                                                updated_at = excluded.updated_at",
            params![id, i as f64, now],
        )
        .map_err(estr)?;
    }
    Ok(())
}

/// Semantic clusters for the Board: cosine union-find over the most recent
/// embedded notes at the tunable `board_cluster_threshold`. Hand corrections
/// (board_links) always win — a corrected note ignores its cosine edges and
/// joins its anchor's cluster instead (or stays loose when the anchor is
/// NULL), so a re-tidy can never undo what the user fixed.
#[tauri::command]
pub async fn board_clusters(app: AppHandle) -> CmdResult<BoardData> {
    let state = app.state::<AppState>();
    let (threshold, ids, vecs, links, pending) = {
        let db = state.db.lock().unwrap();
        let threshold = db::load_settings(&db).board_cluster_threshold.clamp(0.0, 1.0);
        let mut stmt = db
            .prepare(
                "SELECT id, embedding FROM notes
                 WHERE embedding IS NOT NULL AND deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(estr)?;
        let rows = stmt
            .query_map(params![BOARD_CAP as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(estr)?;
        let mut ids = Vec::new();
        let mut vecs = Vec::new();
        for row in rows.filter_map(|r| r.ok()) {
            ids.push(row.0);
            vecs.push(embed::from_blob(&row.1));
        }
        let mut stmt = db
            .prepare("SELECT note_id, anchor_id FROM board_links")
            .map_err(estr)?;
        let links: HashMap<String, Option<String>> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(estr)?
            .filter_map(|r| r.ok())
            .collect();
        let pending: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE embedding IS NULL AND deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(estr)?;
        (threshold, ids, vecs, links, pending)
    };

    let n = ids.len();
    let idx_of: HashMap<&str, usize> =
        ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    // A correction is honored when its anchor resolves inside the working set
    // (or is deliberately NULL). Dangling anchors fall back to automatic.
    let corrected_idx: HashMap<usize, Option<usize>> = links
        .iter()
        .filter_map(|(note, anchor)| {
            let i = *idx_of.get(note.as_str())?;
            match anchor {
                None => Some((i, None)),
                Some(a) => idx_of.get(a.as_str()).map(|&j| (i, Some(j))),
            }
        })
        .collect();

    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        if corrected_idx.contains_key(&i) {
            continue; // hand-placed: cosine doesn't get a vote
        }
        for j in (i + 1)..n {
            if corrected_idx.contains_key(&j) {
                continue;
            }
            if embed::cosine(&vecs[i], &vecs[j]) >= threshold {
                let (ri, rj) = (uf_find(&mut parent, i), uf_find(&mut parent, j));
                if ri != rj {
                    parent[rj] = ri;
                }
            }
        }
    }
    for (&i, anchor) in &corrected_idx {
        if let Some(j) = anchor {
            let (ri, rj) = (uf_find(&mut parent, i), uf_find(&mut parent, *j));
            if ri != rj {
                parent[rj] = ri;
            }
        }
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let root = uf_find(&mut parent, i);
        groups.entry(root).or_default().push(i);
    }

    let db = state.db.lock().unwrap();
    let ranks: HashMap<String, f64> = {
        let mut stmt = db
            .prepare("SELECT note_id, rank FROM board_order")
            .map_err(estr)?;
        let collected: HashMap<String, f64> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(estr)?
            .filter_map(|r| r.ok())
            .collect();
        collected
    };
    let mut clusters: Vec<BoardCluster> = Vec::new();
    let mut loose_ids: Vec<String> = Vec::new();
    for members in groups.into_values() {
        if members.len() < 2 {
            loose_ids.push(ids[members[0]].clone());
            continue;
        }
        // Anchor = most central member (max mean cosine to the rest) — the
        // steadiest identity a computed cluster can have.
        let anchor = members
            .iter()
            .copied()
            .max_by(|&a, &b| {
                let score = |x: usize| -> f32 {
                    members
                        .iter()
                        .filter(|&&m| m != x)
                        .map(|&m| embed::cosine(&vecs[x], &vecs[m]))
                        .sum()
                };
                score(a)
                    .partial_cmp(&score(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(members[0]);
        let member_ids: Vec<String> = members.iter().map(|&i| ids[i].clone()).collect();
        let mut notes = db::get_notes_by_ids_excerpt(&db, &member_ids).map_err(eanyhow)?;
        sort_board_notes(&mut notes, &ranks);

        // Label: the tag most members share — tags are the strongest topic
        // signal around (same reasoning as the auto-arrange prompt). Falls
        // back to the central note's title.
        let mut tag_counts: HashMap<&str, usize> = HashMap::new();
        for note in &notes {
            for t in &note.tags {
                *tag_counts.entry(t.tag.as_str()).or_default() += 1;
            }
        }
        let label_tag = tag_counts
            .iter()
            .filter(|(_, &c)| c >= 2)
            .max_by_key(|(tag, &c)| (c, std::cmp::Reverse(tag.to_string())))
            .map(|(tag, _)| tag.to_string());
        let label = label_tag.clone().unwrap_or_else(|| {
            let anchor_note = notes
                .iter()
                .find(|nn| nn.id == ids[anchor])
                .unwrap_or(&notes[0]);
            let t = anchor_note.title.trim();
            if t.is_empty() {
                "Untitled cluster".to_string()
            } else {
                t.chars().take(40).collect()
            }
        });
        clusters.push(BoardCluster {
            anchor_id: ids[anchor].clone(),
            label,
            label_tag,
            notes,
        });
    }
    // Biggest clusters first — the strongest themes lead the board.
    clusters.sort_by_key(|c| std::cmp::Reverse(c.notes.len()));

    let mut loose = db::get_notes_by_ids_excerpt(&db, &loose_ids).map_err(eanyhow)?;
    sort_board_notes(&mut loose, &ranks);

    let corrected = corrected_idx.keys().map(|&i| ids[i].clone()).collect();
    Ok(BoardData {
        clusters,
        loose,
        corrected,
        pending,
    })
}

/// Record a hand placement: `anchor_id = Some(..)` pins the note to that
/// note's cluster, `None` keeps it deliberately loose. Latest correction wins.
#[tauri::command]
pub async fn set_board_link(
    app: AppHandle,
    note_id: String,
    anchor_id: Option<String>,
) -> CmdResult<()> {
    if anchor_id.as_deref() == Some(note_id.as_str()) {
        return Err("A note can't anchor itself".into());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO board_links(note_id, anchor_id, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(note_id) DO UPDATE SET anchor_id = excluded.anchor_id,
                                            created_at = excluded.created_at",
        params![note_id, anchor_id, now_ms()],
    )
    .map_err(estr)?;
    Ok(())
}

/// Revert a note to automatic placement.
#[tauri::command]
pub async fn clear_board_link(app: AppHandle, note_id: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM board_links WHERE note_id = ?1", params![note_id])
        .map_err(estr)?;
    Ok(())
}

// ---------------------------------------------------------------- stickies

#[tauri::command]
pub async fn list_stickies(app: AppHandle) -> CmdResult<Vec<Sticky>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::list_stickies(&db).map_err(eanyhow)
}

/// Create a text sticky. `placed` is true only when the user pointed at where
/// it goes (a double-click on the Wall); off-Wall captures pass false and land
/// in the Inbox.
#[tauri::command]
pub async fn create_sticky(
    app: AppHandle,
    text: String,
    color: String,
    x: f64,
    y: f64,
    placed: bool,
) -> CmdResult<Sticky> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let z = db::next_sticky_z(&db);
    db.execute(
        "INSERT INTO stickies(id, text, color, x, y, z, placed, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, text, color, x, y, z, placed, now],
    )
    .map_err(estr)?;
    db::get_sticky(&db, &id).map_err(eanyhow)
}

/// Partial update — only the provided fields change. A move (new x/y) also
/// raises the sticky to the front (the one you just touched sits on top).
#[tauri::command]
pub async fn update_sticky(
    app: AppHandle,
    id: String,
    text: Option<String>,
    color: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    placed: Option<bool>,
) -> CmdResult<Sticky> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let new_z: Option<i64> = if x.is_some() || y.is_some() {
        Some(db::next_sticky_z(&db))
    } else {
        None
    };
    db.execute(
        "UPDATE stickies SET
            text = COALESCE(?2, text),
            color = COALESCE(?3, color),
            x = COALESCE(?4, x),
            y = COALESCE(?5, y),
            z = COALESCE(?6, z),
            placed = COALESCE(?7, placed),
            updated_at = ?8
         WHERE id = ?1",
        params![id, text, color, x, y, new_z, placed, now_ms()],
    )
    .map_err(estr)?;
    // A text change re-stales the embedding (text stickies only — linked
    // stickies have no own text and never embed). The frontend only sends
    // `text` when it actually changed.
    if text.is_some() {
        db.execute(
            "UPDATE stickies SET embedding_status = 'STALE' WHERE id = ?1 AND note_id IS NULL",
            params![id],
        )
        .map_err(estr)?;
    }
    db::get_sticky(&db, &id).map_err(eanyhow)
}

/// Hard delete — stickies bypass the notes trash; the returned object feeds an
/// Undo toast (`restore_sticky`).
#[tauri::command]
pub async fn delete_sticky(app: AppHandle, id: String) -> CmdResult<Sticky> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let sticky = db::get_sticky(&db, &id).map_err(eanyhow)?;
    db.execute("DELETE FROM stickies WHERE id = ?1", params![id])
        .map_err(estr)?;
    Ok(sticky)
}

/// Re-insert a deleted sticky (Undo). Same id keeps its identity; a linked
/// sticky whose note has since vanished is silently dropped by the FK.
#[tauri::command]
pub async fn restore_sticky(app: AppHandle, sticky: Sticky) -> CmdResult<Option<Sticky>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO stickies(id, text, color, x, y, z, placed, note_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO NOTHING",
        params![
            sticky.id, sticky.text, sticky.color, sticky.x, sticky.y, sticky.z,
            sticky.placed, sticky.note_id, sticky.created_at, now_ms()
        ],
    )
    .map_err(estr)?;
    Ok(db::get_sticky(&db, &sticky.id).ok())
}

/// Promote a text sticky to a full note: its text becomes the note body, the
/// note enters the normal pipeline (title/tags/summary), and the sticky is
/// consumed. Returns the new note.
#[tauri::command]
pub async fn promote_sticky(app: AppHandle, id: String) -> CmdResult<Note> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let sticky = db::get_sticky(&db, &id).map_err(eanyhow)?;
    if sticky.note_id.is_some() {
        return Err("This sticky already links to a note — open that note instead.".into());
    }
    let note_id = Uuid::new_v4().to_string();
    let now = now_ms();
    db.execute(
        "INSERT INTO notes(id, title, content, folder_id, created_at, updated_at,
                           embedding_status, llm_status)
         VALUES (?1, '', ?2, NULL, ?3, ?3, 'STALE', 'STALE')",
        params![note_id, sticky.text, now],
    )
    .map_err(estr)?;
    db.execute("DELETE FROM stickies WHERE id = ?1", params![id])
        .map_err(estr)?;
    state.last_activity.store(now, Ordering::Relaxed);
    db::get_note(&db, &note_id).map_err(eanyhow)
}

/// Spin a note off as a *linked* sticky — a pointer that lands in the Inbox.
/// The source note is never moved or changed.
#[tauri::command]
pub async fn stick_note(app: AppHandle, note_id: String) -> CmdResult<Sticky> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let exists = db
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![note_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(estr)?
        .is_some();
    if !exists {
        return Err("That note no longer exists.".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let z = db::next_sticky_z(&db);
    db.execute(
        "INSERT INTO stickies(id, text, color, x, y, z, placed, note_id, created_at, updated_at)
         VALUES (?1, '', 'blue', 0, 0, ?2, 0, ?3, ?4, ?4)",
        params![id, z, note_id, now],
    )
    .map_err(estr)?;
    db::get_sticky(&db, &id).map_err(eanyhow)
}

const STALE_AFTER_DAYS: i64 = 30;
const STALE_RECENT_DAYS: i64 = 14;
const STALE_MAX_RESULTS: usize = 12;
const STALE_RECENT_CAP: usize = 20;

/// The anti-forgetting feed: notes untouched for 30+ days, ranked by how
/// close they sit to the centroid of what you've worked on lately. Falls back
/// to longest-forgotten ordering until embeddings can say something smarter.
#[tauri::command]
pub async fn stale_ideas(app: AppHandle) -> CmdResult<Vec<Note>> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let now = now_ms();
    let stale_cutoff = now - STALE_AFTER_DAYS * 86_400_000;
    let recent_cutoff = now - STALE_RECENT_DAYS * 86_400_000;
    let floor = db::load_settings(&db).semantic_search_threshold.clamp(0.0, 1.0);

    // Centroid of recent work — what "today" is about, as a vector.
    let mut stmt = db
        .prepare(
            "SELECT embedding FROM notes
             WHERE embedding IS NOT NULL AND deleted_at IS NULL AND updated_at >= ?1
             ORDER BY updated_at DESC LIMIT ?2",
        )
        .map_err(estr)?;
    let recent: Vec<Vec<f32>> = stmt
        .query_map(params![recent_cutoff, STALE_RECENT_CAP as i64], |r| {
            r.get::<_, Vec<u8>>(0)
        })
        .map_err(estr)?
        .filter_map(|r| r.ok())
        .map(|b| embed::from_blob(&b))
        .collect();
    let centroid: Option<Vec<f32>> = if recent.is_empty() {
        None
    } else {
        let dim = recent[0].len();
        let mut c = vec![0.0f32; dim];
        for v in &recent {
            for (ci, vi) in c.iter_mut().zip(v.iter()) {
                *ci += vi;
            }
        }
        for ci in c.iter_mut() {
            *ci /= recent.len() as f32;
        }
        Some(c)
    };

    let Some(centroid) = centroid else {
        // No recent embedded work to compare against — surface the longest
        // forgotten notes instead of nothing.
        let mut stmt = db
            .prepare(&format!(
                "SELECT id FROM notes WHERE deleted_at IS NULL AND updated_at < ?1
                 ORDER BY updated_at ASC LIMIT {STALE_MAX_RESULTS}"
            ))
            .map_err(estr)?;
        let ids: Vec<String> = stmt
            .query_map(params![stale_cutoff], |r| r.get(0))
            .map_err(estr)?
            .filter_map(|r| r.ok())
            .collect();
        return db::get_notes_by_ids_excerpt(&db, &ids).map_err(eanyhow);
    };

    let mut stmt = db
        .prepare(
            "SELECT id, embedding FROM notes
             WHERE embedding IS NOT NULL AND deleted_at IS NULL AND updated_at < ?1",
        )
        .map_err(estr)?;
    let mut scored: Vec<(String, f32)> = stmt
        .query_map(params![stale_cutoff], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(estr)?
        .filter_map(|r| r.ok())
        .map(|(id, blob)| {
            let score = embed::cosine(&centroid, &embed::from_blob(&blob));
            (id, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.retain(|(_, s)| *s >= floor);
    scored.truncate(STALE_MAX_RESULTS);

    let ids: Vec<String> = scored.iter().map(|(id, _)| id.clone()).collect();
    let mut notes = db::get_notes_by_ids_excerpt(&db, &ids).map_err(eanyhow)?;
    let score_map: HashMap<&str, f32> = scored.iter().map(|(id, s)| (id.as_str(), *s)).collect();
    for note in notes.iter_mut() {
        note.score = score_map.get(note.id.as_str()).copied();
    }
    Ok(notes)
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

/// Generate (or refresh) one note's stored summary on demand. Broadcasts the
/// updated note so cards, hover previews and lists pick it up everywhere.
#[tauri::command]
pub async fn ai_summarize_note(app: AppHandle, note_id: String) -> CmdResult<Note> {
    let label = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let note = db::get_note(&db, &note_id).map_err(eanyhow)?;
        let t = note.title.trim().to_string();
        if t.is_empty() { "Untitled".to_string() } else { t }
    };
    queue::set_activity(&app, Some((format!("Summarizing “{label}”…"), Some(note_id.clone()))));
    let res = ai::summarize_note(&app, &note_id).await.map_err(eanyhow);
    queue::set_activity(&app, None);
    if let Ok(note) = &res {
        let _ = app.emit("note-updated", note);
    }
    res
}

/// Generate a summary for every note that has content but no stored summary,
/// sequentially, publishing live progress through the worker activity label.
/// Returns how many notes were summarized; stops at the first LLM error
/// (it's systemic).
#[tauri::command]
pub async fn ai_summarize_missing(app: AppHandle) -> CmdResult<i64> {
    let notes: Vec<(String, String)> = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id, title FROM notes
                 WHERE TRIM(content) != '' AND deleted_at IS NULL
                   AND (summary IS NULL OR TRIM(summary) = '')
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
                format!("Summarizing “{label}” ({}/{total})…", i + 1),
                Some(id.clone()),
            )),
        );
        match ai::summarize_note(&app, id).await {
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

#[tauri::command]
pub async fn ai_summarize_collection(app: AppHandle, kind: String, key: String) -> CmdResult<String> {
    queue::set_activity(&app, Some(("Summarizing collection…".to_string(), None)));
    let res = ai::summarize_collection(&app, &kind, &key).await.map_err(eanyhow);
    queue::set_activity(&app, None);
    res
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

        // Note summaries ride the LLM pipeline; queue the catch-up work when
        // the feature turns on (notes without one) or the style changes
        // (every note's summary is in the old shape).
        if settings.llm_backend != "none" && settings.summarize_notes {
            let became_available = old.llm_backend == "none";
            let style_changed = old.summarize_notes
                && !became_available
                && old.note_summary_style != settings.note_summary_style;
            let just_enabled = !old.summarize_notes || became_available;
            if style_changed {
                db.execute(
                    "UPDATE notes SET llm_status = 'STALE'
                     WHERE deleted_at IS NULL AND trim(content) != '' AND llm_status = 'CLEAN'",
                    [],
                )
                .map_err(estr)?;
            } else if just_enabled {
                db.execute(
                    "UPDATE notes SET llm_status = 'STALE'
                     WHERE deleted_at IS NULL AND trim(content) != '' AND summary IS NULL
                       AND llm_status = 'CLEAN'",
                    [],
                )
                .map_err(estr)?;
            }
        }

        old.sidecar_binary != settings.sidecar_binary
            || old.model_path != settings.model_path
            || old.sidecar_port != settings.sidecar_port
            || (old.llm_backend == "sidecar" && settings.llm_backend != "sidecar")
    };
    if needs_sidecar_restart {
        ai::kill_sidecar(&app).await;
    }
    queue::emit_status(&app);
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
        // Re-embed text stickies too (linked stickies carry no own text).
        db.execute(
            "UPDATE stickies SET embedding_status = 'STALE'
             WHERE note_id IS NULL AND TRIM(text) != '' AND embedding_status != 'PENDING'",
            [],
        )
        .map_err(estr)?;
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

#[derive(Serialize)]
pub struct NoteVersionContent {
    pub title: String,
    pub content: String,
}

/// Full stored text of one version — fetched on demand by the history
/// diff view (list_note_versions only ships previews).
#[tauri::command]
pub async fn get_note_version(app: AppHandle, version_id: String) -> CmdResult<NoteVersionContent> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.query_row(
        "SELECT title, content FROM note_versions WHERE id = ?1",
        params![version_id],
        |r| {
            Ok(NoteVersionContent {
                title: r.get(0)?,
                content: r.get(1)?,
            })
        },
    )
    .map_err(estr)
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

// ------------------------------------------------------------ auto-arrange

#[tauri::command]
pub async fn plan_auto_arrange(app: AppHandle) -> CmdResult<Vec<ArrangeGroup>> {
    queue::set_activity(&app, Some(("Planning auto-arrange…".to_string(), None)));
    let res = ai::plan_arrange(&app).await.map_err(eanyhow);
    queue::set_activity(&app, None);
    res
}

/// Apply the accepted subset of an auto-arrange plan: create proposed folders
/// (reusing a same-named one if it appeared meanwhile) and move the notes.
#[tauri::command]
pub async fn apply_auto_arrange(app: AppHandle, moves: Vec<ArrangeMove>) -> CmdResult<i64> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let mut folders = db::list_folders(&db).map_err(eanyhow)?;
    let now = now_ms();
    let mut moved = 0i64;
    for m in moves {
        // Resolve the target: a still-existing folder id, else a same-named
        // folder, else create the proposed folder at the top level.
        let target = m
            .folder_id
            .filter(|id| folders.iter().any(|f| &f.id == id))
            .or_else(|| {
                let name = m.folder_name.trim();
                folders
                    .iter()
                    .find(|f| f.name.eq_ignore_ascii_case(name))
                    .map(|f| f.id.clone())
            });
        let target = match target {
            Some(id) => id,
            None => {
                let name = m.folder_name.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let id = Uuid::new_v4().to_string();
                db.execute(
                    "INSERT INTO folders(id, name, parent_id, created_at) VALUES (?1, ?2, NULL, ?3)",
                    params![id, name, now],
                )
                .map_err(estr)?;
                folders.push(Folder {
                    id: id.clone(),
                    name,
                    parent_id: None,
                    created_at: now,
                });
                id
            }
        };
        moved += db
            .execute(
                "UPDATE notes SET folder_id = ?1, suggested_folder_id = NULL
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![target, m.note_id],
            )
            .map_err(estr)? as i64;
    }
    Ok(moved)
}

// ------------------------------------------------------------ prompts

#[tauri::command]
pub async fn get_prompt_defaults() -> CmdResult<serde_json::Value> {
    Ok(crate::prompts::defaults().clone())
}

#[tauri::command]
pub async fn get_prompt_overrides() -> CmdResult<serde_json::Value> {
    Ok(crate::prompts::overrides())
}

/// `{placeholder}` tokens (lowercase + underscore) in a template string.
fn template_tokens(s: &str) -> Vec<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && (bytes[j].is_ascii_lowercase() || bytes[j] == b'_') {
                j += 1;
            }
            if j > start && j < bytes.len() && bytes[j] == b'}' {
                out.push(s[start..j].to_string());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Overrides must stay a sparse subset of the defaults: known tasks, known
/// fields, matching types, schemas/limits untouchable — and every
/// `{placeholder}` from the default template still present, because deleting
/// one silently breaks that feature at run time.
fn validate_prompt_overrides(overrides: &serde_json::Value) -> Result<(), String> {
    if overrides.is_null() {
        return Ok(());
    }
    let Some(map) = overrides.as_object() else {
        return Err("Prompt overrides must be a JSON object".into());
    };
    let defaults = crate::prompts::defaults();
    for (task, fields) in map {
        let dt = &defaults[task.as_str()];
        if !dt.is_object() {
            return Err(format!("Unknown prompt task \"{task}\""));
        }
        let Some(fmap) = fields.as_object() else {
            return Err(format!("Override for \"{task}\" must be a JSON object"));
        };
        for (field, value) in fmap {
            if field == "schema" || field == "schema_name" || field == "limits" {
                return Err(format!("\"{task}.{field}\" is not tunable"));
            }
            let dv = &dt[field.as_str()];
            if dv.is_null() {
                return Err(format!("Unknown field \"{task}.{field}\""));
            }
            if dv.is_string() {
                let Some(v) = value.as_str() else {
                    return Err(format!("\"{task}.{field}\" must be text"));
                };
                for tok in template_tokens(dv.as_str().unwrap()) {
                    if !v.contains(&format!("{{{tok}}}")) {
                        return Err(format!(
                            "\"{task}.{field}\" must keep the {{{tok}}} placeholder — it is filled in at run time"
                        ));
                    }
                }
            } else if dv.is_u64() {
                if !value.is_u64() {
                    return Err(format!("\"{task}.{field}\" must be a number"));
                }
            } else {
                return Err(format!("\"{task}.{field}\" is not tunable"));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_prompt_overrides(
    app: AppHandle,
    overrides: serde_json::Value,
) -> CmdResult<()> {
    validate_prompt_overrides(&overrides)?;
    let state = app.state::<AppState>();
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT INTO settings(key, value) VALUES ('prompt_overrides', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![overrides.to_string()],
        )
        .map_err(estr)?;
    }
    crate::prompts::set_overrides(overrides);
    Ok(())
}

// ------------------------------------------------------------ import

/// Generous per-file cap — a multi-MB "note" is almost certainly not one.
const IMPORT_MAX_BYTES: u64 = 5 * 1024 * 1024;

fn is_note_file(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown" | "txt")
    )
}

/// Recursively gather importable files under a dropped directory. Non-note
/// files inside a directory (images, PDFs, .DS_Store…) are passed over
/// silently — folders legitimately contain them.
fn collect_note_files(path: &std::path::Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 16 {
        return;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with('.') {
        return;
    }
    if path.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for e in entries.flatten() {
                collect_note_files(&e.path(), out, depth + 1);
            }
        }
    } else if is_note_file(path) {
        out.push(path.to_path_buf());
    }
}

/// Parse the YAML front matter block our own exporter writes (title, tags,
/// created, updated). Lenient by design: unknown keys are ignored and any
/// parse failure just means "no front matter" — the whole file becomes content.
fn parse_front_matter(raw: &str) -> (Option<String>, Vec<String>, Option<i64>, Option<i64>, String) {
    let no_fm = |raw: &str| (None, Vec::new(), None, None, raw.to_string());
    let Some(rest) = raw.strip_prefix("---\n").or_else(|| raw.strip_prefix("---\r\n")) else {
        return no_fm(raw);
    };
    let Some(end) = rest.find("\n---") else {
        return no_fm(raw);
    };
    let header = &rest[..end];
    let mut body = &rest[end + 4..];
    body = match body.find('\n') {
        Some(nl) => &body[nl + 1..],
        None => "",
    };
    let body = body.trim_start_matches(['\n', '\r']).to_string();

    let quotes: &[char] = &['"', '\''];
    let (mut title, mut tags, mut created, mut updated) = (None, Vec::new(), None, None);
    for line in header.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "title" => {
                let t = value.trim_matches(quotes).trim();
                if !t.is_empty() {
                    title = Some(t.to_string());
                }
            }
            "tags" => {
                let inner = value.trim_start_matches('[').trim_end_matches(']');
                tags = inner
                    .split(',')
                    .map(|t| t.trim().trim_matches(quotes).to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
            }
            "created" => {
                created = chrono::DateTime::parse_from_rfc3339(value)
                    .ok()
                    .map(|d| d.timestamp_millis());
            }
            "updated" => {
                updated = chrono::DateTime::parse_from_rfc3339(value)
                    .ok()
                    .map(|d| d.timestamp_millis());
            }
            _ => {}
        }
    }
    (title, tags, created, updated, body)
}

/// Import .md/.txt files (or directories of them) as new unfiled notes.
/// Round-trips our own markdown exports (front matter title/tags/dates);
/// imported notes enter both AI queues STALE so they get indexed, titled and
/// tagged like anything typed in the app.
fn import_notes_core(app: &AppHandle, paths: Vec<String>) -> CmdResult<ImportResult> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut ignored = 0i64;
    for p in &paths {
        let path = PathBuf::from(p);
        if path.is_dir() {
            collect_note_files(&path, &mut files, 0);
        } else if is_note_file(&path) {
            files.push(path);
        } else {
            ignored += 1;
        }
    }

    let state = app.state::<AppState>();
    let now = now_ms();
    let (mut imported, mut skipped) = (0i64, 0i64);
    for path in files {
        if std::fs::metadata(&path).map(|m| m.len() > IMPORT_MAX_BYTES).unwrap_or(true) {
            ignored += 1;
            continue;
        }
        let raw = match std::fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => {
                ignored += 1;
                continue;
            }
        };
        let (fm_title, tags, created, updated, content) = parse_front_matter(&raw);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let mut title = fm_title.unwrap_or(stem);
        // Exported placeholders ("untitled", "untitled-3") stay untitled so
        // auto-titling can do its job.
        let lower = title.to_lowercase();
        if lower == "untitled"
            || (lower.starts_with("untitled-") && lower[9..].chars().all(|c| c.is_ascii_digit()))
        {
            title = String::new();
        }
        let content = content.trim().to_string();
        if title.is_empty() && content.is_empty() {
            ignored += 1;
            continue;
        }

        let db = state.db.lock().unwrap();
        let dup: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM notes
                 WHERE title = ?1 AND content = ?2 AND deleted_at IS NULL",
                params![title, content],
                |r| r.get(0),
            )
            .map_err(estr)?;
        if dup > 0 {
            skipped += 1;
            continue;
        }
        let id = Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO notes(id, title, content, folder_id, created_at, updated_at,
                               embedding_status, llm_status, last_embed_input, last_llm_input)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'STALE', 'STALE', '', '')",
            params![
                id,
                title,
                content,
                created.unwrap_or(now),
                updated.or(created).unwrap_or(now)
            ],
        )
        .map_err(estr)?;
        for t in &tags {
            db.execute(
                "INSERT OR IGNORE INTO note_tags(note_id, tag, source) VALUES (?1, ?2, 'manual')",
                params![id, t],
            )
            .map_err(estr)?;
        }
        imported += 1;
    }
    Ok(ImportResult { imported, skipped, ignored })
}

#[tauri::command]
pub async fn import_notes(app: AppHandle, paths: Vec<String>) -> CmdResult<ImportResult> {
    tauri::async_runtime::spawn_blocking(move || import_notes_core(&app, paths))
        .await
        .map_err(estr)?
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
