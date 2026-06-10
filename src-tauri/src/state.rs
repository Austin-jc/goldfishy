use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8};
use std::sync::{Arc, Mutex};

use fastembed::TextEmbedding;
use rusqlite::Connection;

/// Lifecycle of the local embedding model. Kept in an atomic (not behind the
/// `embedder` mutex) so status queries never wait on a download or a running
/// embed batch.
pub mod embedder_phase {
    pub const COLD: u8 = 0;
    pub const DOWNLOADING: u8 = 1;
    pub const LOADING: u8 = 2;
    pub const READY: u8 = 3;
    pub const ERROR: u8 = 4;

    pub fn as_str(phase: u8) -> &'static str {
        match phase {
            DOWNLOADING => "downloading",
            LOADING => "loading",
            READY => "ready",
            ERROR => "error",
            _ => "cold",
        }
    }
}

pub struct SidecarProc {
    pub child: tokio::process::Child,
    pub binary: String,
    pub model_path: String,
    pub port: u16,
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub embedder: Arc<Mutex<Option<TextEmbedding>>>,
    /// Current `embedder_phase` value.
    pub embedder_phase: Arc<AtomicU8>,
    /// Single-flight guard: only one thread downloads/loads the model.
    pub embedder_init: Arc<Mutex<()>>,
    /// Last user interaction (ms epoch) — Queue 2 only runs when the user is idle.
    pub last_activity: Arc<AtomicI64>,
    pub sidecar: Arc<tokio::sync::Mutex<Option<SidecarProc>>>,
    pub http: reqwest::Client,
    /// Backoff timestamps (ms epoch) after pipeline failures so we don't retry every tick.
    pub embed_cooldown_until: Arc<AtomicI64>,
    pub llm_cooldown_until: Arc<AtomicI64>,
    /// True while a manual "Sync / Re-index" sweep is draining the queues.
    pub sweep_active: Arc<AtomicBool>,
    /// What the worker is doing right now: (human label, note id when the
    /// work targets a single note); None when idle. Only ever held for an
    /// instant — safe to read from async status commands.
    pub current_activity: Arc<Mutex<Option<(String, Option<String>)>>>,
    /// Last time the 30-day trash purge ran (ms epoch).
    pub last_trash_purge: Arc<AtomicI64>,
}
