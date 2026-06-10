use std::sync::atomic::Ordering;

use anyhow::{anyhow, Context, Result};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use tauri::{AppHandle, Manager};

use crate::state::{embedder_phase, AppState};

/// Initialise the embedding model if it is not loaded yet. Blocking: call from
/// a blocking context (worker thread / spawn_blocking). The phase atomic is
/// updated (and broadcast via queue-status) so the UI can show download/load
/// progress instead of silently freezing on first launch.
pub fn ensure_embedder_blocking(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    if state.embedder.lock().unwrap().is_some() {
        return Ok(());
    }
    // Single-flight: the first caller initialises; concurrent callers block
    // here (on a blocking-pool thread, never the UI thread) until it is done.
    let _init = state.embedder_init.lock().unwrap();
    if state.embedder.lock().unwrap().is_some() {
        return Ok(());
    }

    let cache_dir = app
        .path()
        .app_data_dir()
        .context("no app data dir")?
        .join("embed-cache");
    let cached = std::fs::read_dir(&cache_dir)
        .map(|mut d| d.next().is_some())
        .unwrap_or(false);
    let phase = if cached { embedder_phase::LOADING } else { embedder_phase::DOWNLOADING };
    state.embedder_phase.store(phase, Ordering::Relaxed);
    crate::queue::emit_status(app);

    let result = TextEmbedding::try_new(
        InitOptions::new(EmbeddingModel::AllMiniLML6V2)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(false),
    )
    .context("failed to initialise embedding model (all-MiniLM-L6-v2)");

    match result {
        Ok(model) => {
            *state.embedder.lock().unwrap() = Some(model);
            state.embedder_phase.store(embedder_phase::READY, Ordering::Relaxed);
            crate::queue::emit_status(app);
            Ok(())
        }
        Err(e) => {
            state.embedder_phase.store(embedder_phase::ERROR, Ordering::Relaxed);
            crate::queue::emit_status(app);
            Err(e)
        }
    }
}

/// Embed a batch of texts. Blocking.
pub fn embed_blocking(app: &AppHandle, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    ensure_embedder_blocking(app)?;
    let state = app.state::<AppState>();
    let mut guard = state.embedder.lock().unwrap();
    let model = guard.as_mut().ok_or_else(|| anyhow!("embedder not loaded"))?;
    let out = model.embed(texts, None)?;
    Ok(out)
}

/// Async wrapper that runs embedding on the blocking thread pool.
pub async fn embed_texts(app: AppHandle, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    tauri::async_runtime::spawn_blocking(move || embed_blocking(&app, texts))
        .await
        .map_err(|e| anyhow!("embedding task panicked: {e}"))?
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

pub fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}
