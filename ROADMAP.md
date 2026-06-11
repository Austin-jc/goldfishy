# GoldFishy — Feature Roadmap

Tracking doc for agreed nice-to-have features. Status: `[ ]` planned · `[~]` in progress · `[x]` shipped. Keep entries updated as features land; implementation notes live in `HANDOFF.md`.

## Foundations

- [x] **Per-feature AI toggles** — every automatic AI behavior individually switchable in Settings: auto-tagging (exists via max-tags=0), folder suggestions, auto-titling, action extraction (exists). Manual buttons stay gated only by having an LLM backend.

## Almost free (infrastructure already exists)

- [x] **Related notes panel** — bottom of the editor shows the 3–4 most similar notes (cosine over existing embeddings, threshold ~0.35), click to open. Makes the semantic engine visible without searching.
- [x] **Snooze on reminder banners** — 15 min / 1 h / tomorrow chips on due banners; re-arms via `set_action_due`.
- [x] **Highlight search matches in opened note** — after opening a keyword-search result, matched terms get a mark-style decoration in the editor; first hit scrolled into view.

## Explorer follow-ups

- [x] **Drag notes between folders** — HTML5 drag in the tree; drop on a folder moves the note, drop on "All Notes" unfiles it. Folders draggable too (new `move_folder` command, cycle-safe).
- [x] **Right-click context menus** — context menu on note rows (open, duplicate, pin, delete) and folder rows (new note, new subfolder, rename, delete); complements the cramped hover icons.
- [x] **Pinned notes** — `pinned` column; pinned section at the top of the explorer; toggle via context menu / editor.

## Editor

- [x] **Task-list checkboxes** — Tiptap TaskList/TaskItem, round-trips `- [ ]` GFM markdown. (Later: sync checked state with action items.)
- [x] **Slash commands** — typing `/` at the start of a block opens an insert menu (headings, lists, task list, quote, code block, divider).
- [x] **Paste images from clipboard** — ⌘V of image data saves through a `save_image_bytes` command and inserts like drag-drop.
- [x] **⌘F find-in-note** — floating find bar with match count, next/prev cycling, mark-style highlights (shares the search-highlight extension).
- [x] **Line numbers** — optional gutter (Settings → Appearance) numbering each top-level block, notepad-style; frontend-only (`nn.lineNumbers`).

## Data safety

- [x] **Trash with restore** — soft delete (`deleted_at`); Trash section in the explorer with restore / delete-forever; auto-purge after 30 days; all queries (lists, search, FTS, queues, tags, action items, exports) exclude trashed notes.
- [x] **Note version history** — snapshot title+content into `note_versions` whenever a significant change (per `diff.rs`) is about to overwrite it; keep last ~20; History popover in the editor with restore.
- [x] **Scheduled backup export** — optional backup folder + interval in Settings; worker runs the existing markdown export periodically.

## Desktop-native

- [x] **Global quick-capture** — system-wide shortcut opens a small always-on-top capture window; Enter files the text as a new note (auto-title/tags pick it up later); Esc dismisses.
- [x] **UI zoom** — ⌘+/⌘− scale the whole UI (webview zoom), ⌘0 resets; level persisted across launches.

## AI organization

- [x] **Clean up & aggregate similar notes** — finds clusters of highly similar notes (cosine over embeddings, union-find at high threshold), shows them as review groups; "Merge" combines them into one note (LLM-merged content, union of tags) and moves the rest to Trash.
- [x] **Regenerate tags** — `ai_retag_all` re-runs the organize pipeline over every note with live per-note progress (AI tags rewritten, manual tags untouched); "regenerate" on the TAGS header (two-step confirm) and a palette command.

## Research-backed top picks (June 2026, from docs/improvements.md)

- [x] **Prompt single source + versioning** (AI-3) — `prompts/prompts.json` shared by `ai.rs` and the bench; `version` stamped into bench results.
- [x] **Keep/discard preview for AI rewrites** (AI-1) — Auto-bullet previews before writing; Keep still snapshots first.
- [x] **No Markdown serialization per keystroke** (PERF-1) — `getMarkdown()` runs once per debounced save.
- [x] **All db-locking commands async** (PERF-2) — file-IO commands additionally on the blocking pool.
- [x] **`list_notes` excerpts + non-blocking first paint** (PERF-3/16) — 240-char server-side previews; tree fills in after the shell paints.
- [x] **`PRAGMA synchronous = NORMAL`** (PERF-7).
- [x] **Search-or-create + palette recents** (NOTE-1/2, UX-1–3) — MRU empty state, Create-from-query everywhere, recency group headers.
- [x] **Single-call worker pipeline** (AI-2/PERF-11) — `organize_note` returns `{title, tags, folder, items}` in one structured call; benchable as `organize`.
- [x] **Embeddings versioned by model id** (AI-7) — model swap auto-wipes vectors and re-indexes.
- [x] **Tag-refresh debounce + memoized tree rows** (PERF-4/6) — kills sidebar churn during worker sweeps.
- [x] **Hybrid smart search** (NOTE-3) — BM25 + embeddings fused with RRF as the default mode; semantic-only hits badged "meaning"; degrades to keyword until the embedder is ready.
- [x] **Palette shortcut hints** (UX-4) — every shortcut-backed action is a palette row with its ⌘-hint (incl. new Quick capture / Find in note / Toggle sidebar commands).
