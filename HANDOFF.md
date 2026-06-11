# GoldFishy — Engineering Handoff

Working knowledge for continuing testing, fixes, and improvements. For product-level docs see `README.md` / `USER_GUIDE.md`; for stable architecture, conventions, motivations, and the research-backed improvements backlog see [`docs/`](docs/README.md).

## Stack & layout

Tauri 2 desktop app. React 19 + Vite + Tailwind v4 + Tiptap (frontend), Rust backend (SQLite via rusqlite, fastembed/ONNX embeddings, any OpenAI-compatible server for LLM work).

```
src/                          # frontend
  App.tsx                     # event listeners, global shortcuts, layout shell
  store.ts                    # zustand store — all shared state, init()
  api.ts                      # one wrapper per Tauri command
  types.ts                    # mirrors Rust models — keep in sync with models.rs
  themes.ts                   # theme registry (id, name, preview swatches)
  index.css                   # design tokens, per-theme variable overrides, editor CSS
  editor/extensions.ts        # LocalImage, toggleUnifiedCodeBlock
  components/
    Sidebar.tsx               # file-tree explorer (notes nested under folders), tag filter, queue footer+popover, bell
    NoteList.tsx              # SearchBar (segmented toggle), SummaryBar, NoteItem (search-result cards)
    Editor.tsx                # Tiptap editor, FolderPicker, BubbleMenu toolbar, AI buttons
    ActionPanel.tsx           # right slide-over: proposed/scheduled/done, categories
    DueDatePicker.tsx         # themed popover calendar+time (replaces native datetime-local)
    ReminderBanners.tsx       # persistent in-app due banners (top center)
    SettingsModal.tsx, CommandPalette.tsx, Toasts.tsx, GoldfishLogo.tsx
src-tauri/src/                # backend
  lib.rs                      # plugin + command registration, eager embedder warm-up
  state.rs                    # AppState, embedder_phase consts
  db.rs                       # schema (additive migrate()), all SQL helpers
  models.rs                   # serde models incl. AppSettings (+Default)
  commands.rs                 # #[tauri::command] handlers
  queue.rs                    # 1s worker tick: reminders → embed queue → LLM queue
  ai.rs                       # chat(), auto-tag, bulletify, summaries, extract_actions
  prompts.rs                  # loader for prompts/prompts.json (single prompt source)
  embed.rs                    # fastembed init (single-flight) + cosine search
  diff.rs                     # significant_change gate so typo fixes skip the queues
```

## Core architecture

**Dual-queue worker** (`queue.rs`, 1s tick): per-note `embedding_status` / `llm_status` ∈ `CLEAN | PENDING | STALE`. Tick order: (1) fire due reminders — runs even in Manual mode; (2) embed batch (≤8 stale notes, debounced); (3) one LLM note (only when embed queue empty AND user idle) → `generate_title` if untitled, `auto_tag_and_route`, then `extract_actions` if enabled. Failures set a 60s cooldown (`*_cooldown_until`). `reindex_all` marks things STALE and sets `sweep_active` for a drain-everything sweep. While working, the worker publishes a live `current_activity` label + `current_note_id` (`AppState.current_activity` → `QueueStatus`) — shown in the sidebar status footer and queue popover (footer clickability keys off activity too, since extraction runs after counts hit zero).

**Auto-titling** (`ai.rs::generate_title`): untitled notes with content get an LLM title when the worker reaches them (and on manual Organize). The SQL guard `WHERE title = ''` prevents clobbering a title the user typed mid-flight; the editor adopts an externally generated title only while its local title field is empty (otherwise autosave would wipe it back).

**Embedder lifecycle**: model (all-MiniLM-L6-v2, ~80MB) warms up eagerly at launch via `spawn_blocking` in `lib.rs`. Phase lives in an **atomic** (`state.rs::embedder_phase`: cold/downloading/loading/ready/error) so status reads never touch the embedder mutex — that mutex is held for whole embed batches. Init is single-flight via `embedder_init` mutex.

**⚠ Tauri main-thread rule**: synchronous `#[tauri::command] fn`s run on the **main/UI thread**. Anything that could wait on a contended lock must be `async fn` (runs on the runtime pool). This was the cause of the original "unresponsive on start" bug. Every command that takes the db lock is async now; file-IO-heavy ones (`export_notes`, `backup_now`, `save_image*`) additionally run on `spawn_blocking`. The only sync commands left are the trivially cheap, lock-free `notify_activity` and `get_data_dir`.

**LLM layer** (`ai.rs::chat`): OpenAI-compatible `/v1/chat/completions` against `external` (Ollama/LM Studio) or `sidecar` (managed llama-server child process, health-polled, killed on exit/config change). Optional `response_format` param passes a strict `json_schema` for constrained decoding; servers that ignore it fall back to prompt + `extract_json` (which only finds `{...}` objects — always ask for an object, not a bare array). `num_ctx: 8192` is sent for Ollama; sidecar gets `-c 8192`.

**Auto-tagging**: max tags from `settings.auto_tag_max` (0=off, default 2); prompt includes the existing tag vocabulary (top 40) for reuse, bans status/filler words; code-side `TAG_STOPWORDS` filter as backstop. AI tags have `source='ai'` and are wiped+rewritten on each run; manual tags are never touched.

**Action items** (`action_items` table): status `proposed | scheduled | done | dismissed`. Extraction (`ai.rs::extract_actions`) prunes proposals that vanished from the note and **never re-proposes** any text already known for that note — dismissed rows are kept as tombstones for this. Due hints come back as `YYYY-MM-DD[ HH:MM]` (LLM resolves "tomorrow" given today's date in the prompt), date-only → 09:00 local. Reminder firing: worker selects `scheduled AND due_at <= now AND notified_at IS NULL`, sets `notified_at`, fires system notification (if `notify_system`) and emits `action-due`; frontend gates banners on `notify_in_app`. Changing `due_at` resets `notified_at` (re-arms). `note_id` is nullable (manual items), `ON DELETE CASCADE`.

**Events** (backend → frontend, listeners in `App.tsx`): `note-updated`, `queue-status`, `worker-error`, `sweep-done`, `action-items-changed`, `action-due`, `model-download-progress`.

**Search**: keyword = FTS5 (`notes_fts`, triggers keep it synced, bm25 + snippet); semantic = in-process cosine scan over embedding BLOBs, threshold 0.25, top 30. Multi-tag filtering is **AND** (`HAVING COUNT(DISTINCT tag) = n` in `db.rs::list_notes`).

## Theming — the one rule

Everything is built from three CSS-variable ramps; **never hardcode a hex in a component**:

- `stone-*` neutrals — semantic, not literal: **950 is always the app background, 100 the strongest text**. Light themes invert the ramp's lightness, the numbers keep their meaning.
- `clay-*` — the single interactive accent (600 = button bg, must keep ~4.5:1 with white text; 300 = accent text on bg; 900/950 = tint backgrounds).
- `sage-*` — reserved for AI-derived things (AI tags, suggestions, success).
- `--color-code-bg` — code block background, one step past the app bg.

Defaults live in `@theme` in `index.css`; each theme is a `[data-theme="x"]` block overriding the same variables (+ `color-scheme` for native controls). Tailwind v4 emits `var()` refs, so overrides retheme everything live. To add a theme: one CSS block + one entry in `themes.ts`. Applied via `document.documentElement.dataset.theme`, persisted as `nn.theme`. Errors stay fixed dark-red with light-red text (readable on every theme).

UI conventions: no borders between regions — tone shifts + whitespace; popover pattern = `fixed inset-0` click-catcher + absolute panel (see QueueFooter/FolderPicker; DueDatePicker uses `fixed` + anchor rect so the scroll container can't clip it); formatting toolbar is a Tiptap `BubbleMenu` on text selection only; lucide icons (v1.17 — check `node_modules/lucide-react/dist/esm/icons/` before using a name). localStorage keys: `nn.theme`, `nn.sidebarWidth`, `nn.sidebarCollapsed`, `nn.expandedFolders`, `nn.tagsOpen`, `nn.notesOpen`, `nn.zoom`.

**Webview zoom**: ⌘+/⌘−/⌘0 set whole-webview zoom (`getCurrentWebview().setZoom`, 0.5–2.0 in 0.1 steps), persisted as `nn.zoom` and re-applied on launch (`App.tsx`); main window only (capture window is fixed-size). Needs `core:webview:allow-set-webview-zoom` in `capabilities/default.json`.

**Sidebar model**: the sidebar is a file explorer — folders expand to show subfolders + their notes; unfiled notes sit at root. `store.view` is only `all | folder` (highlight, new-note target, summary scope); tags are no longer a view but an AND filter (`store.tagFilter`) applied server-side in `refreshNotes` (which always fetches across all folders). Active tag filter auto-expands folders with matches and dims the rest; expansion is otherwise user-toggled and persisted. `delete_tag` removes a tag from every note (+ its cached summary). Flat `NoteItem` cards are used only for search results.

## Settings

`AppSettings` (models.rs ↔ types.ts) is one JSON blob in the `settings` table, `#[serde(default)]` so adding fields is backward-compatible — add to struct + `Default` impl + types.ts + SettingsModal. Backend-owned: automation, debounces, LLM backend config, `auto_tag_max`, `extract_actions`, `notify_in_app`, `notify_system`. Frontend-only (localStorage): theme, sidebar state. Theme picker applies instantly; everything else needs Save.

## Data & invariants

DB: `~/Library/Application Support/com.nexusnote.app/nexusnote.db` (WAL). Migration = `execute_batch` of `IF NOT EXISTS` + ignored `ALTER TABLE ADD COLUMN`s (`pinned`, `deleted_at`) — **additive only**; for column changes you'd need real versioned migrations.

**⚠ Trash invariant**: `delete_note` is a soft delete (`deleted_at`). **Every query that reads notes must filter `deleted_at IS NULL`** — lists, FTS + semantic search, related/similar notes, tag counts, action-item joins, worker queue picks, status counts, exports, bulk auto-title. Forgetting the filter resurrects trashed notes. Trash is purged after 30 days (worker, every ~6h). `merge_notes` soft-deletes its sources and re-links their action items + tags to the target.

**Versions**: `note_versions` (cap 20/note, cascade delete). Snapshots: pre-edit state at most every 10 min (`maybe_snapshot_note`), and unconditionally before AI rewrites (bulletify, merge) and restores. Restore = `restore_note_version` (snapshots current first).

**Backups**: `backup_dir` + `backup_interval_days` settings; worker checks every ~30 min against settings-table key `last_backup_at`, exports a timestamped markdown folder, emits `backup-done`.

**Quick capture**: second webview window, label `capture` (must stay in `capabilities/default.json` windows list); `main.tsx` routes by label. Global shortcut ⌘⇧N registered Rust-side (`tauri-plugin-global-shortcut`). Saving emits `note-captured` (App listens, toasts with Open).

**Per-feature AI toggles** in `AppSettings`: `auto_tag_max` (0=off), `auto_title`, `suggest_folders`, `extract_actions` — gate the worker pipeline and manual Organize; explicit actions (bulk auto-title, merge) stay available whenever an LLM backend is configured.

Editor extras: TaskList/TaskItem (GFM `- [ ]`), `SlashCommands` ("/" insert menu, plain-DOM dropdown via @tiptap/suggestion), `TermHighlight` decorations (search click-through + ⌘F find bar), clipboard image paste (`save_image_bytes`, base64). Sidebar: pinned section, drag-drop note/folder moves (`move_folder` refuses cycles), right-click ContextMenu, Trash section, "Tidy up similar notes" (`find_similar_notes` union-find ≥0.80 cosine + `merge_notes`).

**Do not rename** the bundle `identifier` (`com.nexusnote.app`) or the db filename — either would orphan users' data. Rebrand was deliberately limited to `productName`, window title, and UI text.

## Dev workflow

```bash
npm run tauri dev        # vite + cargo, watches both; tauri.conf.json change = full restart
npm run build            # tsc + vite — the frontend type/build check
cargo check              # in src-tauri/ — fast backend check
```

- Dev profile (`src-tauri/Cargo.toml`): our crate builds at `opt-level = 1`, dependencies at `opt-level = 2` — bundled SQLite and fastembed/tokenizers at -O0 made dev builds feel frozen. Changing these values triggers a one-time full dependency rebuild (several minutes); after that deps stay cached and incremental rebuilds only touch our crate.

- App icon pipeline: edit `app-icon.svg` → rasterize with **sharp** (`node -e "require('sharp')('app-icon.svg',{density:300}).resize(1024,1024).png().toFile('app-icon.png')"`) → `npx tauri icon app-icon.png`. **Don't use qlmanage** — it flattens alpha to white (that was the square-dock-icon bug). macOS caches dock icons (`killall Dock`).
- In-app logo is `GoldfishLogo.tsx` (inline SVG); favicon `public/goldfish.svg` — same geometry, update together.
- Pushing: icon binaries exceeded git's default HTTP buffer; `http.postBuffer` is already raised in local repo config.
- Reminder smoke test without an LLM: insert a row and watch the worker (fires within ~2s):
  ```sql
  INSERT INTO action_items(id,note_id,text,category,status,due_at,created_at,updated_at)
  VALUES ('t1',NULL,'test','test','scheduled',strftime('%s','now')*1000,0,0);
  -- then: SELECT notified_at FROM action_items WHERE id='t1';
  ```
- LLM-dependent testing needs Ollama running (`external`, `http://localhost:11434`) or a llama-server sidecar configured.
- **Model benchmarking**: `npm run bench` (see `bench/README.md`) compares candidate LLMs on every AI feature using the app's exact prompts/schemas/parsing. Prompt text, schemas, token caps and truncation limits live in **`prompts/prompts.json`** — embedded by `src-tauri/src/prompts.rs` (`include_str!`) and read by `bench/src/prompts.ts`, so app and bench can't drift. **Bump its `version` field on any change**; it's stamped into bench results. Reply *parsing* in `bench/src/prompts.ts` is still a hand mirror of `ai.rs` normalization — keep those in sync. Supports any OpenAI-compatible server (the app's wire format) plus Claude models via the Anthropic SDK (`ANTHROPIC_API_KEY`); `--judge` adds Claude-graded quality scores.

## Editor specifics

Tiptap v2 (pinned ~2.27): `StarterKit.configure({ codeBlock: false })` + `CodeBlockLowlight` (lowlight v3 `common` grammars; token colors are theme vars in index.css). `toggleUnifiedCodeBlock` merges a multi-block selection into ONE code block (Tiptap default splits per paragraph) with try/catch fallback for selections crossing list structures. Content is stored as **Markdown** (`tiptap-markdown`, `editor.storage.markdown.getMarkdown()`), autosave debounced 600ms through refs (`dirtyRef`/`saveTimer`), flushed on unmount. New (empty) notes autofocus the title; Enter/↓ moves into the body. Images: drag-drop → copied to app dir, markdown keeps relative `images/...` path, resolved via asset protocol only at render (`LocalImage`).

## Known rough edges / candidate next steps

- Heading/list formatting is only reachable via selection bubble or markdown syntax — a "+" block inserter is the natural next step if discoverability complaints come up.
- Changing tag granularity doesn't re-tag existing notes (needs Re-index); old junk tags linger until then.
- Multi-tag views hide the collection SummaryBar (backend summary key is single-tag).
- Reminder banner actions error (toast) if the row was deleted elsewhere — harmless but sloppy.
- `action-due` system notifications: first one triggers the macOS permission prompt; nothing in-app explains a denial.
- Bundle is ~970KB minified (lowlight grammars + tiptap) — fine for desktop, code-split if it ever matters.
- Categories are free-form lowercase strings; no color coding or rename-across-items yet.
- `extract_actions` runs serially inside the Queue-2 slot, doubling LLM latency per note when enabled.
- Semantic search scans all embeddings in-process — fine to ~thousands of notes; `sqlite-vec` is the contained upgrade path (`embed.rs`).
