# GoldFishy

A lightning-fast, offline-first desktop note-taking app that eliminates manual organization. All data and AI inference stay 100% local.

Built with **Tauri 2** (Rust backend) + **React / TipTap / Tailwind** frontend, **SQLite + FTS5** storage, **all-MiniLM-L6-v2** local embeddings (ONNX via fastembed), and a **llama.cpp** sidecar or any OpenAI-compatible local server for the heavy LLM work.

📖 **Non-technical users: see [USER_GUIDE.md](USER_GUIDE.md)** — how to use the app and switch on the AI features, step by step.

## Features

**Core (offline engine)**
- Markdown WYSIWYG editing (TipTap) — type markdown syntax, get rich text; notes are stored as plain Markdown
- Drag & drop local images — copied into app storage, referenced by portable relative paths
- Instant keyword search — SQLite FTS5, prefix matching, highlighted snippets
- Command palette (⌘K / ⌘P) — fuzzy note search (keyword or semantic via Tab) and `>`-prefixed commands, VS Code style
- Folder hierarchies (nested) and manual tags
- Bulk export as raw Markdown (folder tree mirrored on disk, YAML frontmatter) or JSON

**AI & automation (the smart layer)**
- **Semantic search** — search by meaning, powered by local embeddings (no cloud)
- **The Board** (⌘⇧B) — notes as a wall of cards, auto-clustered by meaning, plus Recent / Stale-ideas / Pinned feeds; drag a card to correct a cluster and the correction sticks through every re-tidy
- **Auto-tagging & routing** — 3 suggested tags applied silently + a destination-folder suggestion you can accept or dismiss
- **Auto-bulleting** — one click restructures stream-of-consciousness text into concise bullets
- **Collection summaries** — one-paragraph synthesis of any folder or tag

**The dual-queue background engine**
- Queue 1 (high priority): embedding pipeline, batched, debounced (default 2s after you stop typing)
- Queue 2 (low priority): LLM pipeline, runs only when Queue 1 is empty **and** you're idle (default 5s)
- Diff checking: minor typo fixes never re-enter the queues
- All AI results fade into the UI without blocking modals

## Getting started

Prereqs: Rust toolchain, Node 18+, Xcode command-line tools (macOS).

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production bundle
```

First semantic search / first background embedding triggers a one-time ~80 MB download of the MiniLM embedding model into the app's cache; everything after that is fully offline.

## Configuring the LLM (bring your own model)

Open **Settings → AI Engine** and pick one of:

1. **Local model (llama.cpp)** — point at a `llama-server` binary (`brew install llama.cpp`) and a `.gguf` file on disk, or paste a HuggingFace repo id (e.g. `bartowski/Llama-3.2-3B-Instruct-GGUF`) and hit Download. GoldFishy spawns and manages the server as a sidecar on demand.
2. **External server** — any OpenAI-compatible endpoint, e.g. Ollama (`http://localhost:11434`, model `llama3.2`) or LM Studio.
3. **Disabled** — everything except the LLM features still works (keyword + semantic search, folders, tags, export).

**Settings → Processing** controls automation: Full Auto vs Manual Only, both debounce timers, and **Sync / Re-index** to sweep notes that were skipped while in manual mode.

## Data

Everything lives in the app data directory (`~/Library/Application Support/com.nexusnote.app` on macOS):

- `nexusnote.db` — SQLite database (notes, folders, tags, embeddings, queue states, settings)
- `images/` — embedded images
- `models/` — downloaded GGUF models
- `embed-cache/` — the ONNX embedding model

Notes are plain Markdown in the DB and export losslessly; the schema tracks `embedding_status` / `llm_status` (`CLEAN | PENDING | STALE`) per note so the background queues always know what to process.

## Architecture notes

- Embedding vectors are stored as BLOBs and ranked with an in-process cosine scan — at personal-notes scale (thousands of notes) this is well under the 50 ms budget and avoids native extension headaches. The spec's `sqlite-vss` extension is unmaintained; swapping in `sqlite-vec` later is a contained change in `src-tauri/src/embed.rs`.
- Phase 3 (local API webhooks / watch folders) is not yet implemented, per the spec marking it "Future".
