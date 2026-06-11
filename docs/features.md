# Features & functionality

The complete list of what GoldFishy does today, grouped by area. User-facing instructions live in [`USER_GUIDE.md`](../USER_GUIDE.md); status tracking for planned work lives in [`ROADMAP.md`](../ROADMAP.md).

## Editing

- **Markdown WYSIWYG** (Tiptap): type markdown syntax, get rich text; notes stored as plain Markdown and export losslessly.
- **Selection bubble toolbar** — formatting appears only on text selection (bold, headings, lists, quotes, code…).
- **Unified code blocks** — multi-paragraph selections merge into one highlighted block (lowlight, theme-aware token colors).
- **Slash commands** — `/` at block start opens an insert menu (headings, lists, task list, quote, code block, divider).
- **Task lists** — GFM `- [ ]` checkboxes, round-trip with Markdown.
- **Images** — drag-drop or paste from clipboard; copied into app storage, portable relative paths.
- **Autosave** — debounced 600 ms, flushed on unmount; no Save button anywhere.
- **Find in note** — ⌘F floating bar with match count, next/prev, highlight decorations.
- **Selection → action item** — right-click any text selection to file it as a scheduled action item linked to the note (or copy it).
- **Line numbers** — optional gutter numbering each block (Settings → Appearance, applies instantly).
- **Auto-bullet** — one click restructures stream-of-consciousness text into concise bullets, shown as a keep/discard preview; nothing is written until Keep (which snapshots first).

## Organization

- **Folders** — nested hierarchy; file-tree sidebar; drag-drop note and folder moves (cycle-safe); right-click context menus.
- **Tags** — manual tags plus AI tags (visually distinct, sage-colored ✨); sidebar tag filter with AND semantics; delete-tag removes it everywhere.
- **Pinned notes** — pinned section at the top of the explorer.
- **Folder suggestions** — AI proposes a destination folder; nothing moves without Accept.
- **Tidy up similar notes** — finds clusters of near-duplicate notes (cosine ≥ 0.80, union-find) and offers LLM-merged consolidation; sources go to Trash, tags/actions re-link.

## Search & retrieval

- **Keyword search** — instant FTS5 with prefix matching and highlighted snippets; matches highlighted inside the opened note too.
- **Smart search (default)** — keyword (FTS5/bm25) and semantic (embeddings) run in parallel, rankings fused with Reciprocal Rank Fusion; results that matched by meaning alone carry a ✨ "meaning" badge. Keyword-only and semantic-only stay available as explicit modes (toggle in the search bar, Tab in the palette). Similarity floors for search, related notes, and Tidy-up merging are tunable in Settings → Search & Similarity.
- **Search-or-create** — zero-results searches offer to create a note titled with the query (sidebar and palette); results group under Today / Yesterday / Previous-days headers.
- **Command palette** — ⌘K/⌘P: fuzzy note search (keyword/semantic), `>`-prefixed commands, VS Code style; empty query shows recently opened notes, and any query grows a "Create note" row (↵ on zero results, ⇧↵ anytime).
- **Related notes** — most-similar notes at the bottom of the editor (cosine over embeddings).
- **Collection summaries** — one-paragraph LLM synthesis of any folder or tag, cached.

## AI & automation

- **Auto-tagging** — up to N tags (configurable, 0 = off) applied quietly after you stop typing; reuses existing vocabulary; stopword filtering.
- **Auto-titling** — untitled notes get an LLM title; never clobbers a user-typed title.
- **Action extraction** — finds tasks/follow-ups in notes, proposes them with category + parsed due dates ("tomorrow" resolved); dismissed items never re-proposed.
- **Dual-queue background engine** — embeddings (batched, debounced) take strict priority over LLM work (one note at a time, only while idle); a diff gate keeps typo fixes out of both queues; live status footer shows what's being worked on.
- **Per-feature toggles** — auto-tag, auto-title, folder suggestions, action extraction each switchable; Full Auto vs Manual mode; Sync/Re-index sweep.
- **Bring-your-own model** — managed llama-server sidecar (with in-app GGUF download) or any OpenAI-compatible server (Ollama, LM Studio); everything except LLM features works with AI disabled.
- **Model benchmarking** — `npm run bench` compares candidate models on the app's exact prompts/schemas, optional Claude-graded quality scores.

## Action items & reminders

- **Actions panel** (bell): Proposed / Scheduled / Completed groups, category chips with filtering, manual add.
- **Reminders** — due items fire in-app banners (with Done / Snooze 15m/1h/tomorrow / Open) and optional system notifications; re-arm on date change.

## Data safety

- **Trash** — soft delete with restore, auto-purge after 30 days, two-step delete in the editor.
- **Version history** — snapshots before significant overwrites and all AI rewrites; last ~20 per note; restore from History popover.
- **Backups** — optional scheduled export (folder + interval) of the full markdown tree.
- **Export** — bulk Markdown (folder tree mirrored on disk, YAML frontmatter) or JSON; images copied alongside.

## Desktop-native

- **Global quick capture** — system-wide ⌘⇧N opens a small always-on-top window; Enter files the note (AI titles/tags it later).
- **UI zoom** — ⌘+/⌘− scale the whole UI, ⌘0 resets; persisted.
- **System notifications** — for due reminders (per-setting).

## Theming & UI

- **Theme system** — every color comes from three CSS-variable ramps (`stone` neutrals, `clay` accent, `sage` for AI-derived things); per-theme override blocks; live switching; native controls follow `color-scheme`.
- **Design conventions** — no borders between regions (tone + whitespace), popover pattern, lucide icons.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘N | New note |
| ⌘K / ⌘P | Command palette |
| ⌘F | Find in note |
| ⌘, | Settings |
| ⌘\ | Toggle sidebar |
| ⌘+ / ⌘− / ⌘0 | Zoom in / out / reset |
| ⌘⇧N | Global quick capture (system-wide) |
| `/` at block start | Insert menu |
| `>` in palette | Command mode |
| Tab in palette/search | Toggle keyword ↔ semantic |
