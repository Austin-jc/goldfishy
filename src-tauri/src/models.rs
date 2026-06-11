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
        }
    }
}
