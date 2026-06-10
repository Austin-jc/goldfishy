use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Arc, Mutex};

use fastembed::TextEmbedding;
use rusqlite::Connection;

pub struct SidecarProc {
    pub child: tokio::process::Child,
    pub binary: String,
    pub model_path: String,
    pub port: u16,
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub embedder: Arc<Mutex<Option<TextEmbedding>>>,
    /// Last user interaction (ms epoch) — Queue 2 only runs when the user is idle.
    pub last_activity: Arc<AtomicI64>,
    pub sidecar: Arc<tokio::sync::Mutex<Option<SidecarProc>>>,
    pub http: reqwest::Client,
    /// Backoff timestamps (ms epoch) after pipeline failures so we don't retry every tick.
    pub embed_cooldown_until: Arc<AtomicI64>,
    pub llm_cooldown_until: Arc<AtomicI64>,
    /// True while a manual "Sync / Re-index" sweep is draining the queues.
    pub sweep_active: Arc<AtomicBool>,
}
