use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

use crate::models::{ActionItem, AppSettings, Folder, Note, NoteTag, TagCount};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open(app: &AppHandle) -> Result<Connection> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(dir.join("images"))?;
    std::fs::create_dir_all(dir.join("models"))?;
    std::fs::create_dir_all(dir.join("embed-cache"))?;
    let conn = Connection::open(dir.join("nexusnote.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // WAL guarantees consistency at NORMAL; only durability of the very last
    // commits is at risk on power loss. Autosave commits 4-6×/save — fsyncing
    // each at FULL held the db mutex for the disk flush.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            embedding BLOB,
            embedding_status TEXT NOT NULL DEFAULT 'STALE',
            llm_status TEXT NOT NULL DEFAULT 'STALE',
            last_embed_input TEXT,
            last_llm_input TEXT,
            suggested_folder_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
        CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
        CREATE INDEX IF NOT EXISTS idx_notes_embed_status ON notes(embedding_status);
        CREATE INDEX IF NOT EXISTS idx_notes_llm_status ON notes(llm_status);

        CREATE TABLE IF NOT EXISTS note_tags (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            PRIMARY KEY (note_id, tag)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, content,
            content='notes', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, content ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS collection_summaries (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            summary TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (kind, key)
        );

        CREATE TABLE IF NOT EXISTS action_items (
            id TEXT PRIMARY KEY,
            note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'general',
            status TEXT NOT NULL DEFAULT 'proposed',
            due_at INTEGER,
            notified_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_actions_status ON action_items(status);
        CREATE INDEX IF NOT EXISTS idx_actions_due ON action_items(due_at);
        CREATE INDEX IF NOT EXISTS idx_actions_note ON action_items(note_id);

        CREATE TABLE IF NOT EXISTS note_versions (
            id TEXT PRIMARY KEY,
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at);
        "#,
    )?;
    // Additive column migrations — "duplicate column name" on re-run is fine.
    let _ = conn.execute(
        "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE notes ADD COLUMN deleted_at INTEGER", []);
    Ok(())
}

/// The text fed to both AI pipelines for a note.
pub fn ai_input(title: &str, content: &str) -> String {
    format!("{}\n\n{}", title, content)
}

const NOTE_COLS: &str = "id, title, content, folder_id, created_at, updated_at, embedding_status, llm_status, suggested_folder_id, (embedding IS NOT NULL), pinned, deleted_at";

/// Same shape, but `content` trimmed server-side. List views only render short
/// previews (≤220 chars after markdown stripping) and the editor loads full
/// content via `get_note`, so list payloads/memory stay flat as notes grow.
/// SQLite `substr` counts characters for TEXT, so this never splits a UTF-8
/// code point.
const NOTE_COLS_EXCERPT: &str = "id, title, substr(content, 1, 240) AS content, folder_id, created_at, updated_at, embedding_status, llm_status, suggested_folder_id, (embedding IS NOT NULL), pinned, deleted_at";

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        folder_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        embedding_status: row.get(6)?,
        llm_status: row.get(7)?,
        suggested_folder_id: row.get(8)?,
        has_embedding: row.get(9)?,
        pinned: row.get(10)?,
        deleted_at: row.get(11)?,
        tags: Vec::new(),
        score: None,
        snippet: None,
    })
}

fn attach_tags(conn: &Connection, notes: &mut [Note]) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }
    let mut by_id: HashMap<String, Vec<NoteTag>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT note_id, tag, source FROM note_tags ORDER BY tag")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            NoteTag {
                tag: r.get(1)?,
                source: r.get(2)?,
            },
        ))
    })?;
    for row in rows {
        let (id, tag) = row?;
        by_id.entry(id).or_default().push(tag);
    }
    for n in notes.iter_mut() {
        if let Some(tags) = by_id.remove(&n.id) {
            n.tags = tags;
        }
    }
    Ok(())
}

pub fn get_note(conn: &Connection, id: &str) -> Result<Note> {
    let mut note = conn.query_row(
        &format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"),
        params![id],
        row_to_note,
    )?;
    let mut stmt = conn.prepare("SELECT tag, source FROM note_tags WHERE note_id = ?1 ORDER BY tag")?;
    let tags = stmt
        .query_map(params![id], |r| {
            Ok(NoteTag {
                tag: r.get(0)?,
                source: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    note.tags = tags;
    Ok(note)
}

/// `excerpt` returns trimmed content (NOTE_COLS_EXCERPT) — what the UI's list
/// views want. Pass `false` where full content matters (export, summaries).
pub fn list_notes(
    conn: &Connection,
    folder_id: Option<&str>,
    tags: Option<&[String]>,
    excerpt: bool,
) -> Result<Vec<Note>> {
    let cols = if excerpt { NOTE_COLS_EXCERPT } else { NOTE_COLS };
    let tags = tags.unwrap_or(&[]);
    let mut notes: Vec<Note> = match (folder_id, tags.is_empty()) {
        (Some(f), _) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {cols} FROM notes
                 WHERE folder_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC"
            ))?;
            let rows = stmt.query_map(params![f], row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
        (None, false) => {
            // Notes carrying ALL of the selected tags.
            let placeholders = vec!["?"; tags.len()].join(",");
            let mut stmt = conn.prepare(&format!(
                "SELECT {cols} FROM notes WHERE deleted_at IS NULL AND id IN (
                    SELECT note_id FROM note_tags WHERE tag IN ({placeholders})
                    GROUP BY note_id HAVING COUNT(DISTINCT tag) = {}
                 ) ORDER BY updated_at DESC",
                tags.len()
            ))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(tags.iter()), row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
        (None, true) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {cols} FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC"
            ))?;
            let rows = stmt.query_map([], row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    attach_tags(conn, &mut notes)?;
    Ok(notes)
}

/// Soft-deleted notes, most recently trashed first.
pub fn list_trashed(conn: &Connection) -> Result<Vec<Note>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {NOTE_COLS} FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    ))?;
    let rows = stmt.query_map([], row_to_note)?;
    let mut notes = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    attach_tags(conn, &mut notes)?;
    Ok(notes)
}

pub fn get_notes_by_ids(conn: &Connection, ids: &[String]) -> Result<Vec<Note>> {
    let mut notes = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(n) = conn
            .query_row(
                &format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"),
                params![id],
                row_to_note,
            )
            .optional()?
        {
            notes.push(n);
        }
    }
    attach_tags(conn, &mut notes)?;
    Ok(notes)
}

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>> {
    let mut stmt =
        conn.prepare("SELECT id, name, parent_id, created_at FROM folders ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| {
        Ok(Folder {
            id: r.get(0)?,
            name: r.get(1)?,
            parent_id: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT t.tag, COUNT(*) FROM note_tags t
         JOIN notes n ON n.id = t.note_id AND n.deleted_at IS NULL
         GROUP BY t.tag ORDER BY COUNT(*) DESC, t.tag COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount {
            tag: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Recursively collect a folder id plus all of its descendants.
pub fn folder_with_descendants(conn: &Connection, folder_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        r#"
        WITH RECURSIVE sub(id) AS (
            SELECT id FROM folders WHERE id = ?1
            UNION ALL
            SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
        )
        SELECT id FROM sub
        "#,
    )?;
    let rows = stmt.query_map(params![folder_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ------------------------------------------------------------- action items

const ACTION_COLS: &str = "a.id, a.note_id, COALESCE(n.title, ''), a.text, a.category, a.status, a.due_at, a.notified_at, a.created_at, a.updated_at";

fn row_to_action(row: &rusqlite::Row) -> rusqlite::Result<ActionItem> {
    Ok(ActionItem {
        id: row.get(0)?,
        note_id: row.get(1)?,
        note_title: row.get(2)?,
        text: row.get(3)?,
        category: row.get(4)?,
        status: row.get(5)?,
        due_at: row.get(6)?,
        notified_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub fn list_action_items(conn: &Connection) -> Result<Vec<ActionItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTION_COLS} FROM action_items a
         LEFT JOIN notes n ON n.id = a.note_id
         WHERE a.status != 'dismissed' AND (a.note_id IS NULL OR n.deleted_at IS NULL)
         ORDER BY (a.due_at IS NULL), a.due_at ASC, a.created_at DESC"
    ))?;
    let rows = stmt.query_map([], row_to_action)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_action_item(conn: &Connection, id: &str) -> Result<ActionItem> {
    Ok(conn.query_row(
        &format!(
            "SELECT {ACTION_COLS} FROM action_items a
             LEFT JOIN notes n ON n.id = a.note_id WHERE a.id = ?1"
        ),
        params![id],
        row_to_action,
    )?)
}

// ------------------------------------------------------------- note versions

const MAX_VERSIONS_PER_NOTE: i64 = 20;
/// Don't snapshot more often than this — autosave fires every 600ms.
const VERSION_MIN_GAP_MS: i64 = 10 * 60 * 1000;

/// Unconditionally store a version snapshot (and trim to the cap).
pub fn snapshot_note(conn: &Connection, note_id: &str, title: &str, content: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO note_versions(id, note_id, title, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![uuid::Uuid::new_v4().to_string(), note_id, title, content, now_ms()],
    )?;
    conn.execute(
        "DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN (
            SELECT id FROM note_versions WHERE note_id = ?1
            ORDER BY created_at DESC LIMIT ?2
         )",
        params![note_id, MAX_VERSIONS_PER_NOTE],
    )?;
    Ok(())
}

/// Snapshot the pre-edit state, but at most once per gap window, so the
/// history reads as meaningful checkpoints instead of keystroke noise.
pub fn maybe_snapshot_note(
    conn: &Connection,
    note_id: &str,
    title: &str,
    content: &str,
) -> Result<()> {
    if title.trim().is_empty() && content.trim().is_empty() {
        return Ok(());
    }
    let latest: Option<i64> = conn
        .query_row(
            "SELECT MAX(created_at) FROM note_versions WHERE note_id = ?1",
            params![note_id],
            |r| r.get(0),
        )
        .unwrap_or(None);
    if latest.is_none_or(|t| now_ms() - t > VERSION_MIN_GAP_MS) {
        snapshot_note(conn, note_id, title, content)?;
    }
    Ok(())
}

pub fn load_settings(conn: &Connection) -> AppSettings {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(conn: &Connection, s: &AppSettings) -> Result<()> {
    let json = serde_json::to_string(s)?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('app', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![json],
    )?;
    Ok(())
}
