use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::time::Instant;

use crate::db::{self, now_ms};
use crate::models::{ActionItem, AppSettings, Note};
use crate::state::{AppState, SidecarProc};

/// Context window we ask the backend to use. Long-note tasks overflow the
/// common 4096 default — `bulletify` sends ~12k chars (~4k tokens) and
/// `summarize_collection` ~16k chars (~5k tokens) — which gets silently
/// truncated. 8192 covers every prompt with room for the response.
const LLM_NUM_CTX: u32 = 8192;

pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn strip_fences(s: &str) -> String {
    let t = s.trim();
    if !t.starts_with("```") {
        return t.to_string();
    }
    let mut lines: Vec<&str> = t.lines().collect();
    if !lines.is_empty() {
        lines.remove(0);
    }
    if let Some(last) = lines.last() {
        if last.trim_start().starts_with("```") {
            lines.pop();
        }
    }
    lines.join("\n").trim().to_string()
}

pub fn extract_json(s: &str) -> Option<serde_json::Value> {
    let cleaned = strip_fences(s);
    let start = cleaned.find('{')?;
    let end = cleaned.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&cleaned[start..=end]).ok()
}

fn normalize_tag(t: &str) -> String {
    t.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(40)
        .collect()
}

fn current_settings(app: &AppHandle) -> AppSettings {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db::load_settings(&db)
}

/// Start (or reuse) the llama.cpp `llama-server` sidecar and return its base URL.
pub async fn ensure_sidecar(app: &AppHandle, settings: &AppSettings) -> Result<String> {
    if settings.sidecar_binary.trim().is_empty() {
        bail!("No llama-server binary configured. Open Settings → AI Engine and pick one.");
    }
    if settings.model_path.trim().is_empty() {
        bail!("No GGUF model configured. Open Settings → AI Engine and pick or download one.");
    }
    let state = app.state::<AppState>();
    let url = format!("http://127.0.0.1:{}", settings.sidecar_port);
    let mut guard = state.sidecar.lock().await;

    if let Some(proc) = guard.as_mut() {
        let alive = proc.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
        if alive
            && proc.binary == settings.sidecar_binary
            && proc.model_path == settings.model_path
            && proc.port == settings.sidecar_port
        {
            return Ok(url);
        }
        let _ = proc.child.start_kill();
        *guard = None;
    }

    let child = tokio::process::Command::new(&settings.sidecar_binary)
        .args([
            "-m",
            &settings.model_path,
            "--host",
            "127.0.0.1",
            "--port",
            &settings.sidecar_port.to_string(),
            "-c",
            &LLM_NUM_CTX.to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("failed to start llama-server at {}", settings.sidecar_binary))?;

    let mut proc = SidecarProc {
        child,
        binary: settings.sidecar_binary.clone(),
        model_path: settings.model_path.clone(),
        port: settings.sidecar_port,
    };

    let http = state.http.clone();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if let Ok(Some(status)) = proc.child.try_wait() {
            bail!("llama-server exited during startup ({status}). Check the binary and model paths.");
        }
        if let Ok(resp) = http
            .get(format!("{url}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            if resp.status().is_success() {
                break;
            }
        }
        if Instant::now() > deadline {
            let _ = proc.child.start_kill();
            bail!("llama-server did not become healthy within 180s");
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }

    *guard = Some(proc);
    Ok(url)
}

pub async fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut guard = state.sidecar.lock().await;
    if let Some(proc) = guard.as_mut() {
        let _ = proc.child.start_kill();
    }
    *guard = None;
}

/// One-shot chat completion against whichever backend is configured.
/// Works with llama-server, Ollama, LM Studio, vLLM — anything OpenAI-compatible.
///
/// `response_format` is an optional OpenAI-style `response_format` value (e.g. a
/// `json_schema`) for backends that support constrained decoding; servers that
/// don't recognise it ignore it, so callers should still validate the reply.
pub async fn chat(
    app: &AppHandle,
    system: &str,
    user: &str,
    max_tokens: u32,
    response_format: Option<serde_json::Value>,
) -> Result<String> {
    let settings = current_settings(app);
    let (base, model, api_key) = match settings.llm_backend.as_str() {
        "external" => {
            let base = settings.external_url.trim().trim_end_matches('/').to_string();
            if base.is_empty() {
                bail!("External server URL is empty. Set it in Settings → AI Engine.");
            }
            let model = if settings.external_model.trim().is_empty() {
                "default".to_string()
            } else {
                settings.external_model.trim().to_string()
            };
            (base, model, settings.external_api_key.clone())
        }
        "sidecar" => {
            let base = ensure_sidecar(app, &settings).await?;
            (base, "local".to_string(), String::new())
        }
        _ => bail!("No LLM backend configured. Open Settings → AI Engine to choose one."),
    };

    let mut body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
        "max_tokens": max_tokens,
        // Ollama-specific hint so long prompts aren't truncated to its 4096
        // default. Ignored by servers (llama-server, vLLM, …) that size the
        // context window at load time instead.
        "num_ctx": LLM_NUM_CTX,
    });
    if let Some(rf) = response_format {
        body["response_format"] = rf;
    }

    let state = app.state::<AppState>();
    let mut req = state
        .http
        .post(format!("{base}/v1/chat/completions"))
        .timeout(Duration::from_secs(300))
        .json(&body);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }

    let resp = req.send().await.context("LLM request failed — is the server running?")?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .context("LLM server returned a non-JSON response")?;
    if !status.is_success() {
        bail!("LLM server error {status}: {body}");
    }
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow!("LLM response missing choices[0].message.content"))?;
    Ok(content.trim().to_string())
}

/// Queue 2 task: suggest 3 tags and a destination folder for a note.
pub async fn auto_tag_and_route(app: &AppHandle, note_id: &str) -> Result<Note> {
    let state = app.state::<AppState>();
    let (input, title, content, folders, existing_tags, max_tags, suggest_folders) = {
        let db = state.db.lock().unwrap();
        let note = db::get_note(&db, note_id)?;
        let folders = db::list_folders(&db)?;
        let existing_tags: Vec<String> = db::list_tags(&db)?
            .into_iter()
            .take(40)
            .map(|t| t.tag)
            .collect();
        let settings = db::load_settings(&db);
        (
            db::ai_input(&note.title, &note.content),
            note.title,
            note.content,
            folders,
            existing_tags,
            settings.auto_tag_max.min(5) as usize,
            settings.suggest_folders,
        )
    };

    let folder_names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
    let folders_json = serde_json::to_string(&folder_names)?;
    let tags_json = serde_json::to_string(&existing_tags)?;
    let system = "You are the organization engine inside a note-taking app. Reply with ONLY valid JSON. No prose, no markdown fences.";
    let tag_instructions = if max_tags == 0 {
        "Return an empty tags list.".to_string()
    } else {
        format!(
            "Suggest at most {max_tags} short lowercase topical tags (1-2 words each) — fewer is \
             better, and an empty list is fine if nothing fits strongly. Tags must name the note's \
             topic or domain (e.g. \"rust\", \"recipes\", \"travel\"). Reuse a tag from this \
             existing vocabulary whenever one fits: {tags_json}. Never use status or filler words \
             (done, todo, wip, note, notes, text, misc, stuff, idea, random), bare verbs, or words \
             that merely appear in the note without describing it."
        )
    };
    let folder_instructions = if suggest_folders {
        format!(
            "Also choose the single best destination folder for the note from this list: \
             {folders_json}. Use null for the folder if none fits well or the list is empty."
        )
    } else {
        "Use null for the folder.".to_string()
    };
    let user = format!(
        "{tag_instructions}\n\
         {folder_instructions}\n\n\
         NOTE TITLE: {}\nNOTE CONTENT:\n{}\n\n\
         Reply with JSON exactly like: {{\"tags\": [\"tag1\"], \"folder\": \"folder name or null\"}}",
        truncate_chars(&title, 200),
        truncate_chars(&content, 6000),
    );

    // Constrain the reply to our exact shape on backends that support it
    // (Ollama structured outputs, llama.cpp grammars). On backends that ignore
    // `response_format`, the prompt above plus `extract_json` still apply.
    let schema = json!({
        "type": "json_schema",
        "json_schema": {
            "name": "note_meta",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "folder": {"type": ["string", "null"]},
                },
                "required": ["tags", "folder"],
                "additionalProperties": false,
            },
        },
    });

    let reply = chat(app, system, &user, 250, Some(schema)).await?;
    let parsed =
        extract_json(&reply).ok_or_else(|| anyhow!("could not parse LLM reply as JSON: {reply}"))?;

    const TAG_STOPWORDS: [&str; 12] = [
        "done", "todo", "wip", "note", "notes", "text", "misc", "stuff", "idea", "ideas",
        "random", "general",
    ];
    let tags: Vec<String> = parsed["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(normalize_tag)
                .filter(|t| !t.is_empty() && !TAG_STOPWORDS.contains(&t.as_str()))
                .take(max_tags)
                .collect()
        })
        .unwrap_or_default();
    let folder_name = if suggest_folders {
        parsed["folder"].as_str().map(str::to_string)
    } else {
        None
    };

    let db = state.db.lock().unwrap();
    db.execute(
        "DELETE FROM note_tags WHERE note_id = ?1 AND source = 'ai'",
        rusqlite::params![note_id],
    )?;
    for t in &tags {
        db.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag, source) VALUES (?1, ?2, 'ai')",
            rusqlite::params![note_id, t],
        )?;
    }

    let current_folder: Option<String> =
        db.query_row("SELECT folder_id FROM notes WHERE id = ?1", rusqlite::params![note_id], |r| {
            r.get(0)
        })?;
    let suggested = folder_name
        .and_then(|name| {
            folders
                .iter()
                .find(|f| f.name.eq_ignore_ascii_case(name.trim()))
                .map(|f| f.id.clone())
        })
        .filter(|id| Some(id) != current_folder.as_ref());

    db.execute(
        "UPDATE notes SET suggested_folder_id = ?1, last_llm_input = ?2 WHERE id = ?3",
        rusqlite::params![suggested, input, note_id],
    )?;
    // Only mark CLEAN if the note wasn't edited again while the LLM was running.
    db.execute(
        "UPDATE notes SET llm_status = 'CLEAN' WHERE id = ?1 AND llm_status = 'PENDING'",
        rusqlite::params![note_id],
    )?;

    Ok(db::get_note(&db, note_id)?)
}

fn normalize_action_text(s: &str) -> String {
    s.trim()
        .trim_end_matches(['.', '!'])
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse an LLM-provided due hint: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM",
/// interpreted in local time (date-only defaults to 09:00).
fn parse_due(s: &str) -> Option<i64> {
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
    let t = s.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("null") {
        return None;
    }
    let naive: NaiveDateTime = NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M")
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(t, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(9, 0, 0))
        })?;
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp_millis())
}

/// Extract action items / follow-ups from a note. New findings land as
/// `proposed`; items the user already accepted, completed or dismissed are
/// never re-proposed, and proposals that disappear from the note are pruned.
pub async fn extract_actions(app: &AppHandle, note_id: &str) -> Result<Vec<ActionItem>> {
    let state = app.state::<AppState>();
    let (title, content, categories) = {
        let db = state.db.lock().unwrap();
        let note = db::get_note(&db, note_id)?;
        let mut stmt = db.prepare("SELECT DISTINCT category FROM action_items ORDER BY category")?;
        let cats: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        (note.title, note.content, cats)
    };
    if title.trim().is_empty() && content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let today = chrono::Local::now().format("%Y-%m-%d (%A)").to_string();
    let cats_json = serde_json::to_string(&categories)?;
    let system = "You extract action items from personal notes. Reply with ONLY valid JSON. No prose, no markdown fences.";
    let user = format!(
        "Today is {today}. Extract up to 6 concrete action items (tasks, follow-ups, reminders) \
         from the note below. Only include real actions the author still needs to do — not facts, \
         ideas, or completed work. If there are none, return an empty list.\n\
         For each item give: \"text\" (short imperative phrase), \"category\" (one or two lowercase \
         words; reuse one of {cats_json} when it fits, else invent a sensible one like \"work\", \
         \"errands\", \"health\", \"follow-up\"), and \"due\" — \"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM\" \
         if the note implies a date or deadline (resolve relative phrases like \"tomorrow\" or \
         \"next friday\" using today's date), else null.\n\n\
         NOTE TITLE: {}\nNOTE CONTENT:\n{}\n\n\
         Reply with JSON exactly like: {{\"items\": [{{\"text\": \"...\", \"category\": \"...\", \"due\": null}}]}}",
        truncate_chars(&title, 200),
        truncate_chars(&content, 8000),
    );

    let schema = json!({
        "type": "json_schema",
        "json_schema": {
            "name": "action_items",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "category": {"type": "string"},
                                "due": {"type": ["string", "null"]},
                            },
                            "required": ["text", "category", "due"],
                            "additionalProperties": false,
                        },
                    },
                },
                "required": ["items"],
                "additionalProperties": false,
            },
        },
    });

    let reply = chat(app, system, &user, 600, Some(schema)).await?;
    let parsed =
        extract_json(&reply).ok_or_else(|| anyhow!("could not parse LLM reply as JSON: {reply}"))?;
    let extracted: Vec<(String, String, Option<i64>)> = parsed["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let text = v["text"].as_str()?.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    let category = v["category"]
                        .as_str()
                        .map(normalize_tag)
                        .filter(|c| !c.is_empty())
                        .unwrap_or_else(|| "general".to_string());
                    let due = v["due"].as_str().and_then(parse_due);
                    Some((truncate_chars(&text, 200), category, due))
                })
                .take(6)
                .collect()
        })
        .unwrap_or_default();

    let now = now_ms();
    {
        let db = state.db.lock().unwrap();
        let existing: Vec<(String, String, String)> = {
            let mut stmt =
                db.prepare("SELECT id, text, status FROM action_items WHERE note_id = ?1")?;
            let rows = stmt.query_map(rusqlite::params![note_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let new_keys: Vec<String> = extracted
            .iter()
            .map(|(t, _, _)| normalize_action_text(t))
            .collect();

        // Prune proposals that no longer appear in the note.
        for (id, text, status) in &existing {
            if status == "proposed" && !new_keys.contains(&normalize_action_text(text)) {
                db.execute("DELETE FROM action_items WHERE id = ?1", rusqlite::params![id])?;
            }
        }
        // Insert genuinely new items (never re-propose known ones, incl. dismissed).
        for (text, category, due) in &extracted {
            let key = normalize_action_text(text);
            if existing.iter().any(|(_, t, _)| normalize_action_text(t) == key) {
                continue;
            }
            db.execute(
                "INSERT INTO action_items(id, note_id, text, category, status, due_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'proposed', ?5, ?6, ?6)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), note_id, text, category, due, now],
            )?;
        }
    }

    let _ = app.emit("action-items-changed", ());
    let db = state.db.lock().unwrap();
    Ok(db::list_action_items(&db)?
        .into_iter()
        .filter(|a| a.note_id.as_deref() == Some(note_id) && a.status == "proposed")
        .collect())
}

/// Restructure stream-of-consciousness text into concise markdown bullets.
pub async fn bulletify(app: &AppHandle, note_id: &str) -> Result<Note> {
    let state = app.state::<AppState>();
    let content = {
        let db = state.db.lock().unwrap();
        let note = db::get_note(&db, note_id)?;
        if note.content.trim().is_empty() {
            bail!("Note is empty — nothing to restructure.");
        }
        note.content
    };

    let system = "You restructure messy notes into clean markdown. Reply with ONLY the restructured markdown — no preamble, no explanation.";
    let user = format!(
        "Rewrite the following stream-of-consciousness note as concise markdown bullet points. \
         Group related points under short bold headings where it helps. Preserve every distinct \
         piece of information, all links and image references.\n\n{}",
        truncate_chars(&content, 12000),
    );

    let reply = chat(app, system, &user, 2048, None).await?;
    let new_content = strip_fences(&reply);
    if new_content.trim().is_empty() {
        bail!("LLM returned an empty result");
    }

    let db = state.db.lock().unwrap();
    // AI rewrites always checkpoint the original first.
    let before = db::get_note(&db, note_id)?;
    db::snapshot_note(&db, note_id, &before.title, &before.content)?;
    db.execute(
        "UPDATE notes SET content = ?1, updated_at = ?2, embedding_status = 'STALE', llm_status = 'STALE' WHERE id = ?3",
        rusqlite::params![new_content, now_ms(), note_id],
    )?;
    Ok(db::get_note(&db, note_id)?)
}

/// Generate a short title for an untitled note. Returns the note unchanged
/// if it has been titled in the meantime or has no content.
pub async fn generate_title(app: &AppHandle, note_id: &str) -> Result<Note> {
    let state = app.state::<AppState>();
    let content = {
        let db = state.db.lock().unwrap();
        let note = db::get_note(&db, note_id)?;
        if !note.title.trim().is_empty() || note.content.trim().is_empty() {
            return Ok(note);
        }
        note.content
    };

    let system = "You title notes. Reply with ONLY the title text — plain words, no quotes, no markdown, no trailing punctuation.";
    let user = format!(
        "Write a concise, descriptive title (3-8 words) for this note:\n\n{}",
        truncate_chars(&content, 4000),
    );
    let reply = chat(app, system, &user, 32, None).await?;
    let title: String = strip_fences(&reply)
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .trim_matches(['"', '“', '”', '\'', '`', '#'])
        .trim_end_matches(['.', '!'])
        .trim()
        .chars()
        .take(80)
        .collect();
    if title.is_empty() {
        bail!("LLM returned an empty title");
    }

    let db = state.db.lock().unwrap();
    // `AND title = ''` guards against a title the user typed while we waited.
    db.execute(
        "UPDATE notes SET title = ?1, updated_at = ?2, embedding_status = 'STALE'
         WHERE id = ?3 AND title = ''",
        rusqlite::params![title, now_ms(), note_id],
    )?;
    Ok(db::get_note(&db, note_id)?)
}

/// Synthesize a one-paragraph summary of all notes in a folder (recursive) or tag.
pub async fn summarize_collection(app: &AppHandle, kind: &str, key: &str) -> Result<String> {
    let state = app.state::<AppState>();
    let notes = {
        let db = state.db.lock().unwrap();
        match kind {
            "folder" => {
                let ids = db::folder_with_descendants(&db, key)?;
                let mut all = Vec::new();
                for fid in ids {
                    all.extend(db::list_notes(&db, Some(&fid), None)?);
                }
                all
            }
            "tag" => {
                let tags = vec![key.to_string()];
                db::list_notes(&db, None, Some(&tags))?
            }
            _ => db::list_notes(&db, None, None)?,
        }
    };
    if notes.is_empty() {
        bail!("No notes in this collection yet.");
    }

    let mut corpus = String::new();
    for n in notes.iter().take(40) {
        corpus.push_str(&format!(
            "## {}\n{}\n\n",
            if n.title.is_empty() { "(untitled)" } else { &n.title },
            truncate_chars(&n.content, 1200)
        ));
        if corpus.len() > 16000 {
            break;
        }
    }

    let system = "You summarize collections of personal notes. Reply with ONLY the summary paragraph — no heading, no preamble.";
    let user = format!(
        "Write one concise paragraph (4-6 sentences) that synthesizes the key themes, facts, \
         decisions and open items across this collection of {} notes:\n\n{corpus}",
        notes.len()
    );
    let summary = chat(app, system, &user, 500, None).await?;
    let summary = strip_fences(&summary);

    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO collection_summaries(kind, key, summary, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at",
        rusqlite::params![kind, key, summary, now_ms()],
    )?;
    Ok(summary)
}

#[derive(Deserialize)]
struct HfEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
}

#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    file: String,
    downloaded: u64,
    total: u64,
    done: bool,
}

/// Download a GGUF from a HuggingFace repo into the app's model cache.
/// Prefers a Q4_K_M quant, otherwise picks the smallest .gguf in the repo.
pub async fn download_hf_model(app: &AppHandle, repo: &str) -> Result<String> {
    let repo = repo.trim().trim_matches('/');
    if repo.is_empty() || !repo.contains('/') {
        bail!("Enter a HuggingFace repo id like TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF");
    }
    let state = app.state::<AppState>();
    let http = state.http.clone();

    let entries: Vec<HfEntry> = http
        .get(format!("https://huggingface.co/api/models/{repo}/tree/main?recursive=true"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .context("could not reach huggingface.co")?
        .error_for_status()
        .with_context(|| format!("HuggingFace repo '{repo}' not found or not accessible"))?
        .json()
        .await
        .context("unexpected response from HuggingFace API")?;

    let mut ggufs: Vec<&HfEntry> = entries
        .iter()
        .filter(|e| e.kind == "file" && e.path.to_lowercase().ends_with(".gguf"))
        .collect();
    if ggufs.is_empty() {
        bail!("No .gguf files found in '{repo}'");
    }
    ggufs.sort_by_key(|e| if e.size == 0 { u64::MAX } else { e.size });
    let chosen = ggufs
        .iter()
        .find(|e| e.path.to_lowercase().contains("q4_k_m"))
        .copied()
        .unwrap_or(ggufs[0]);

    let fname = chosen
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&chosen.path)
        .to_string();
    let dest_dir = app.path().app_data_dir()?.join("models");
    tokio::fs::create_dir_all(&dest_dir).await?;
    let dest = dest_dir.join(&fname);
    let tmp = dest_dir.join(format!("{fname}.part"));

    let resp = http
        .get(format!("https://huggingface.co/{repo}/resolve/main/{}", chosen.path))
        .send()
        .await
        .context("download request failed")?
        .error_for_status()
        .context("download request rejected")?;
    let total = resp.content_length().unwrap_or(chosen.size);

    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("download interrupted")?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 4 * 1024 * 1024 {
            last_emit = downloaded;
            let _ = app.emit(
                "model-download-progress",
                DownloadProgress { file: fname.clone(), downloaded, total, done: false },
            );
        }
    }
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&tmp, &dest).await?;

    let dest_str = dest.to_string_lossy().to_string();
    {
        let db = state.db.lock().unwrap();
        let mut s = db::load_settings(&db);
        s.model_path = dest_str.clone();
        s.hf_repo = repo.to_string();
        db::save_settings(&db, &s)?;
    }
    let _ = app.emit(
        "model-download-progress",
        DownloadProgress { file: fname, downloaded, total, done: true },
    );
    Ok(dest_str)
}
