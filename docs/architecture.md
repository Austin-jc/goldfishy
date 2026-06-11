# Architecture

The stable, big-picture description of how GoldFishy is built. Working-level details and gotchas live in [`HANDOFF.md`](../HANDOFF.md); feature status lives in [`ROADMAP.md`](../ROADMAP.md).

## System overview

GoldFishy is a **local-first Tauri 2 desktop app**: a React webview frontend talking over Tauri IPC to a Rust backend that owns all data and all AI work. Nothing leaves the machine.

```
┌────────────────────────── webview (React 19 + TS) ──────────────────────────┐
│  App.tsx ── event listeners, global shortcuts, layout shell                 │
│  store.ts ─ zustand store: all shared state, init()                         │
│  api.ts ── one typed wrapper per Tauri command                              │
│  components/ (Sidebar, NoteList, Editor[Tiptap], ActionPanel, …)            │
└───────────────▲──────────────────────────────┬──────────────────────────────┘
        events  │ (note-updated, queue-status…)│ invoke (commands)
┌───────────────┴──────────────────────────────▼─────────────────── Rust ─────┐
│  commands.rs   #[tauri::command] handlers                                   │
│  queue.rs      1s background worker: reminders → embed queue → LLM queue    │
│  ai.rs         LLM calls (chat, titles, tags, actions, summaries, merge)    │
│  embed.rs      fastembed (all-MiniLM-L6-v2, ONNX) + cosine search           │
│  db.rs         SQLite schema + all SQL helpers          diff.rs change gate │
└───────┬──────────────────────┬───────────────────────────┬──────────────────┘
        ▼                      ▼                           ▼
  SQLite (WAL)          local embedder              OpenAI-compatible LLM
  nexusnote.db          ~80 MB ONNX model           (Ollama / llama-server
  + FTS5 index          in embed-cache/              sidecar; optional)
```

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | Tauri 2 | macOS-first; second hidden webview window for quick capture |
| Frontend | React 19, TypeScript, Vite, Tailwind v4 | zustand store; themes via CSS-variable ramps |
| Editor | Tiptap v2 (~2.27 pinned) | content stored as **Markdown** (`tiptap-markdown`) |
| Storage | SQLite via rusqlite (bundled), WAL | FTS5 for keyword search; embeddings as BLOBs |
| Embeddings | fastembed / ONNX, all-MiniLM-L6-v2 | eager warm-up at launch on a blocking thread |
| LLM | any OpenAI-compatible `/v1/chat/completions` | `external` (Ollama/LM Studio) or managed `sidecar` (llama-server child process) |

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `notes` | id, title, content (Markdown), folder_id, timestamps, `pinned`, `deleted_at` (soft delete), `embedding` BLOB, `embedding_status` / `llm_status` ∈ `CLEAN \| PENDING \| STALE`, `last_embed_input`, folder suggestion |
| `folders` | nested folders (`parent_id`) |
| `note_tags` | tags per note; `source = 'ai' \| manual` — AI tags are wiped + rewritten per run, manual tags never touched |
| `notes_fts` | FTS5 virtual table, kept in sync by `notes_ai/ad/au` triggers; bm25 ranking + snippets |
| `action_items` | extracted/manual todos: status `proposed \| scheduled \| done \| dismissed`, `due_at`, `notified_at`; `note_id` nullable, `ON DELETE CASCADE`; dismissed rows kept as tombstones so items are never re-proposed |
| `note_versions` | snapshot history, cap 20/note, cascade delete |
| `collection_summaries` | cached folder/tag summaries |
| `settings` | one JSON blob (`AppSettings`) + scalar keys like `last_backup_at` |

Indexes exist on folder, updated_at, both status columns, and action item status/due/note.

**Status lifecycle**: edits that pass the `diff.rs` significant-change gate mark a note `STALE` in both pipelines; the worker claims it (`PENDING`), then writes results and marks `CLEAN`. Failures revert to `STALE` with a 60s cooldown. `reindex_all` marks everything STALE and sets `sweep_active` to drain regardless of debounces.

## The background engine (queue.rs)

A single async worker ticks every 1s:

1. **Reminders** — fire due `action_items` (system notification + `action-due` event); runs even in Manual mode. Also: trash purge (~6h cadence) and scheduled backups (~30 min check).
2. **Queue 1 — embeddings** (high priority): batch up to 8 STALE notes, debounced after typing stops; embeds on the blocking pool; strict priority over Queue 2.
3. **Queue 2 — LLM** (low priority): one note per tick, only when Queue 1 is empty and the user is idle: `generate_title` (if untitled) → `auto_tag_and_route` → `extract_actions` (if enabled).

The worker publishes a live `current_activity` label + note id into `QueueStatus` so the UI can show what's being processed.

## Concurrency model

- `AppState` holds: `db: Mutex<Connection>`, `embedder: Mutex<Option<TextEmbedding>>`, single-flight `embedder_init` mutex, `embedder_phase` **atomic** (cold/downloading/loading/ready/error), cooldown/activity atomics, tokio-mutex sidecar handle.
- **Main-thread rule (critical)**: synchronous `#[tauri::command] fn`s run on the macOS main/UI thread. Anything that can wait on a contended lock or do real work must be `async fn` (runtime pool) or `spawn_blocking`.
- DB lock scopes are kept short; embedding and LLM calls never hold the DB lock.
- Status reads never touch the embedder mutex (phase atomic instead) — that mutex is held for whole embed batches/downloads.

## Search

- **Keyword**: FTS5 `notes_fts`, prefix matching, bm25 + highlighted snippets.
- **Semantic**: embed the query, in-process cosine scan over all embedding BLOBs (threshold 0.25, top 30). Fine to ~thousands of notes; `sqlite-vec` is the contained upgrade path inside `embed.rs`.
- Multi-tag filtering is AND semantics, applied server-side in `list_notes`.

## Events (backend → frontend)

`note-updated`, `queue-status`, `worker-error`, `sweep-done`, `action-items-changed`, `action-due`, `model-download-progress`, `backup-done`, `note-captured`. Listeners are registered once in `App.tsx`.

## Windows

- **main** — the app.
- **capture** — small hidden always-on-top window created at startup, summoned by global ⌘⇧N (registered Rust-side). Both windows share the bundle; `main.tsx` routes by window label. Both must stay listed in `capabilities/default.json`.

## On-disk layout

`~/Library/Application Support/com.nexusnote.app/`: `nexusnote.db` (WAL), `images/` (pasted/dropped images, referenced by relative path), `models/` (downloaded GGUF), `embed-cache/` (ONNX model). **Never rename** the bundle identifier or db filename — it would orphan user data.

## Standing invariants

- **Trash**: every query that reads notes filters `deleted_at IS NULL` — lists, both searches, related/similar, tag counts, action-item joins, queue picks, exports.
- **Migrations are additive only** (`IF NOT EXISTS` + ignored `ALTER TABLE ADD COLUMN`).
- **Versions**: snapshot before AI rewrites (bulletify, merge) and restores; pre-edit snapshot at most every 10 min.
- **Prompt single source**: `prompts/prompts.json` holds every prompt/schema/limit, embedded by `src-tauri/src/prompts.rs` and read by `bench/src/prompts.ts`; its `version` field is bumped on change and stamped into bench results. Reply-parsing code in `bench/src/prompts.ts` still mirrors `ai.rs` by hand.
