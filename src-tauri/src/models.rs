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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
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
pub struct QueueStatus {
    pub embed_stale: i64,
    pub embed_pending: i64,
    pub llm_stale: i64,
    pub llm_pending: i64,
    pub sweep_active: bool,
    pub embedder_ready: bool,
    pub embedder_state: String, // cold | downloading | loading | ready | error
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
        }
    }
}
