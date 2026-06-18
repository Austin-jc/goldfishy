use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NoteTag {
    pub tag: String,
    pub source: String, // "manual" | "ai"
}

#[derive(Serialize, Clone, Debug)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<NoteTag>,
    pub embedding_status: String, // CLEAN | PENDING | STALE
    pub llm_status: String,       // CLEAN | PENDING | STALE
    pub suggested_folder_id: Option<String>,
    pub has_embedding: bool,
    pub pinned: bool,
    pub deleted_at: Option<i64>,
    /// AI-generated per-note summary (style per settings); None until generated.
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Smart-search provenance: "keyword" | "semantic" | "both" — which
    /// engine(s) surfaced this result. Only set by the hybrid mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_by: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

/// One folder's worth of an auto-arrange plan: where a set of unfiled notes
/// should go. `folder_id` is None when the LLM proposed a new folder —
/// `apply_auto_arrange` creates it (or reuses a same-named one) on apply.
#[derive(Serialize, Clone, Debug)]
pub struct ArrangeGroup {
    pub folder_id: Option<String>,
    pub folder_name: String,
    pub is_new: bool,
    pub notes: Vec<Note>,
}

/// One accepted move from the auto-arrange review modal.
#[derive(Deserialize, Clone, Debug)]
pub struct ArrangeMove {
    pub note_id: String,
    pub folder_id: Option<String>,
    pub folder_name: String,
}

/// One semantic cluster on the Board. `anchor_id` is the most central member
/// — drag-corrections attach to it so they survive re-clustering.
#[derive(Serialize, Clone, Debug)]
pub struct BoardCluster {
    pub anchor_id: String,
    pub label: String,
    /// Set when the label is a real tag — dropping a note here also nudges
    /// that tag onto it, so the correction compounds (search, filters).
    pub label_tag: Option<String>,
    pub notes: Vec<Note>,
}

#[derive(Serialize, Clone, Debug)]
pub struct BoardData {
    /// Multi-note clusters, biggest first.
    pub clusters: Vec<BoardCluster>,
    /// Singletons — embedded notes that didn't cluster with anything.
    pub loose: Vec<Note>,
    /// Note ids placed by hand (a board_links row) — badged in the UI.
    pub corrected: Vec<String>,
    /// Live notes still waiting for an embedding (not on the board yet).
    pub pending: i64,
}

/// A sticky on the Wall. A *text sticky* owns its `text`; a *linked sticky*
/// (`note_id` set) is a pointer to a note, with `note_title`/`note_preview`
/// resolved at list time. Stickies are their own object — never titled,
/// tagged, summarized, or otherwise touched by the LLM pipeline.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Sticky {
    pub id: String,
    pub text: String,
    pub color: String,
    pub x: f64,
    pub y: f64,
    pub z: i64,
    /// false = sitting in the Inbox, not yet hand-placed on the Wall. The
    /// system only sets this true when the user pointed at where it goes.
    pub placed: bool,
    /// Set on a linked sticky — the note it points at.
    pub note_id: Option<String>,
    /// Live note title/preview for a linked sticky (resolved at list time).
    #[serde(default)]
    pub note_title: Option<String>,
    #[serde(default)]
    pub note_preview: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ImportResult {
    /// Notes created.
    pub imported: i64,
    /// Files skipped because an identical note already exists.
    pub skipped: i64,
    /// Paths ignored (unsupported extension, unreadable, oversized).
    pub ignored: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ActionItem {
    pub id: String,
    pub note_id: Option<String>,
    pub note_title: String,
    pub text: String,
    pub category: String,
    pub status: String, // proposed | scheduled | done | dismissed
    pub due_at: Option<i64>,
    pub notified_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A history entry as listed in the UI — content arrives as a short preview;
/// the full text stays server-side until a restore.
#[derive(Serialize, Clone, Debug)]
pub struct NoteVersionMeta {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub preview: String,
    pub chars: i64,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct QueueStatus {
    pub embed_stale: i64,
    pub embed_pending: i64,
    pub llm_stale: i64,
    pub llm_pending: i64,
    pub sweep_active: bool,
    pub embedder_ready: bool,
    pub embedder_state: String, // cold | downloading | loading | ready | error
    /// What the worker is doing right now (live label), None when idle.
    pub current_activity: Option<String>,
    /// Note the live activity targets, when it's a single note.
    pub current_note_id: Option<String>,
    /// Post-error pause deadlines (ms epoch; 0 / past = not paused). The
    /// frontend counts these down so the retry plan is visible, not silent.
    pub embed_cooldown_until: i64,
    pub llm_cooldown_until: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppSettings {
    pub automation_mode: String, // "auto" | "manual"
    pub embed_debounce_secs: u64,
    pub llm_debounce_secs: u64,
    pub llm_backend: String, // "none" | "external" | "sidecar"
    pub external_url: String,
    pub external_model: String,
    pub external_api_key: String,
    pub sidecar_binary: String,
    pub model_path: String,
    pub sidecar_port: u16,
    pub hf_repo: String,
    /// Max tags the auto-tagger may apply per note (0 disables auto-tagging).
    pub auto_tag_max: u32,
    /// Generate titles for untitled notes in the LLM pipeline.
    pub auto_title: bool,
    /// Let the AI suggest a destination folder while organizing.
    pub suggest_folders: bool,
    /// Extract action items automatically as part of the LLM pipeline.
    pub extract_actions: bool,
    /// Show due reminders as in-app banners.
    pub notify_in_app: bool,
    /// Fire native system notifications for due reminders.
    pub notify_system: bool,
    /// Folder for periodic markdown backups; empty = backups off.
    pub backup_dir: String,
    /// Days between automatic backups.
    pub backup_interval_days: u32,
    /// Cosine floor for semantic search hits (also the smart mode's semantic
    /// leg). Lower = broader, noisier matches.
    pub semantic_search_threshold: f32,
    /// Cosine floor for the editor's Related-notes panel.
    pub related_notes_threshold: f32,
    /// Cosine floor for "Tidy up" merge candidates.
    pub similar_merge_threshold: f32,
    /// Cosine floor for Board clusters — looser than merge (topical groups,
    /// not duplicates), tighter than related-notes.
    pub board_cluster_threshold: f32,
    /// Keep an AI summary of every note up to date (LLM pipeline).
    pub summarize_notes: bool,
    /// Shape of note summaries: "blurb" | "bullets" | "todos".
    pub note_summary_style: String,
    /// What Board sticky cards show: "summary" | "excerpt" (summary falls
    /// back to the excerpt while a note has no summary yet).
    pub board_preview: String,
    /// What the explorer hover preview shows: "summary" | "excerpt".
    pub hover_preview: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            automation_mode: "auto".into(),
            embed_debounce_secs: 2,
            llm_debounce_secs: 5,
            llm_backend: "none".into(),
            external_url: "http://localhost:11434".into(),
            external_model: "".into(),
            external_api_key: "".into(),
            sidecar_binary: "".into(),
            model_path: "".into(),
            sidecar_port: 8757,
            hf_repo: "".into(),
            auto_tag_max: 2,
            auto_title: true,
            suggest_folders: true,
            extract_actions: true,
            notify_in_app: true,
            notify_system: true,
            backup_dir: "".into(),
            backup_interval_days: 7,
            semantic_search_threshold: 0.25,
            related_notes_threshold: 0.35,
            similar_merge_threshold: 0.80,
            board_cluster_threshold: 0.45,
            summarize_notes: true,
            note_summary_style: "blurb".into(),
            board_preview: "summary".into(),
            hover_preview: "summary".into(),
        }
    }
}
