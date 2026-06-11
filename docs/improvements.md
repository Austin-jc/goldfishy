# Improvements backlog (research-backed)

Findings from a research pass (June 2026) across three areas: AI-integration best practices, lessons from leading note-taking apps, and performance — each filtered for applicability to GoldFishy and verified against the actual code. Treat this as a menu: promote items into `ROADMAP.md` when committed; delete items we decide against (note why).

## Top picks (highest value across all sections)

1. ✅ **Single source of truth for prompts + prompt versioning** (AI-3) — replaces the error-prone `ai.rs` ↔ `bench/src/prompts.ts` hand-mirror. *Adopting this changes golden rule 5 in `conventions.md`.* — **done:** `prompts/prompts.json` + `prompts.rs` loader; version stamped into bench results.
2. ✅ **Preview/undo for AI rewrites** (AI-1, UX-6) — three independent research streams converged here; bulletify currently replaces text with only a buried snapshot as recourse. — **done:** Auto-bullet now shows a sage-framed keep/discard preview; nothing is written until Keep (which still snapshots first).
3. ✅ **Stop serializing Markdown per keystroke** (PERF-1) — typing latency, small fix. — **done:** `getMarkdown()` now runs once inside the debounced `saveNow()`.
4. ✅ **Async-ify the remaining sync commands** (PERF-2) — the other half of the startup-unresponsiveness fix; mechanical. — **done:** every db-locking command is `async fn`; export/backup/image-save run on the blocking pool.
5. ✅ **`list_notes` returns excerpts, not full content; don't block first paint on it** (PERF-3, PERF-16). — **done:** 240-char server-side excerpts; `duplicateNote` fetches the full note; `ready` no longer waits for the note list.
6. ✅ **`PRAGMA synchronous = NORMAL`** (PERF-7) — one line, safe in WAL, faster autosaves.
7. ✅ **Search-or-create + recents in the palette** (NOTE-1, NOTE-2, UX-1–3) — the single highest-leverage notepad interaction pattern. — **done:** MRU recents on empty palette, Create-from-query row (↵ on zero results, ⇧↵ anytime), zero-results Create button in SearchBar, recency group headers in results.
8. ✅ **Collapse the per-note LLM pipeline into one structured call** (AI-2, PERF-11) — roughly halves per-note wall time and tokens. — **done:** `ai::organize_note` (one `{title, tags, folder, items}` call) drives Queue-2; benchable as the `organize` feature.
9. ✅ **Version embeddings by model id** (AI-7) — prerequisite for any model swap (quantized MiniLM / Model2Vec, PERF-12). — **done:** `embed::EMBED_MODEL_ID` recorded in settings; mismatch at startup wipes vectors and auto-starts a sweep.
10. ✅ **Coalesce the `note-updated` → `refreshTags` storm + memoize tree rows** (PERF-4, PERF-6) — kills background churn during sweeps. — **done:** 400 ms trailing debounce on tag refresh; `TreeNoteRow`/`FolderNode`/`NoteItem` memoized; hover snippets computed only while showing; sidebar's queue subscription narrowed to a busy boolean.

---

## AI-integration best practices

Gaps first, ordered by value. Verified against `HANDOFF.md` and the code before being marked a gap.

- ✅ **AI-1 · Never silently replace user text — preview or one-tap undo.** Apple Writing Tools cycles each change with "Use Original"; Notion AI always ends keep/try-again/discard ([Smashing on agentic UX](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)). *Here:* `runBulletify` applies immediately with only a success toast; the snapshot is buried in History. Minimum: an **Undo** action on the toast calling `restore_note_version`. Better: sage-tinted keep/discard preview. (Merge already does review-first — keep that pattern.) *(Shipped June 2026: keep/discard preview via `ai_bulletify_preview` + `apply_note_rewrite`.)*
- ✅ **AI-2 · One structured call per note, not three.** Per-call overhead dominates with small local models. *Here:* Queue-2 runs `generate_title` → `auto_tag_and_route` → `extract_actions` serially; one `json_schema` call returning `{title, tags, suggested_folder, actions}` halves wall time. Bench the quality cost first. *(Shipped June 2026 — `organize_note`; quality benchable via `npm run bench -- --features organize`.)*
- ✅ **AI-3 · Prompts as versioned artifacts, single source.** Duplicated prompts drift and evals silently measure the wrong thing ([prompt versioning guide](https://agenta.ai/blog/prompt-versioning-guide)). *Here:* the bench mirror rule is exactly this failure mode. Move prompts/schemas to one shared file (`include_str!` in Rust, imported in TS, or codegen), add `PROMPT_VERSION`, stamp it into bench results. *(Shipped June 2026.)*
- **AI-4 · Error states name the failing component and the recovery plan.** *Here:* `worker-error` toasts raw errors; the 60s cooldown is invisible. Show cooldown in the queue footer ("LLM backend unreachable — retrying in 60s") and distinguish backend-down from schema-parse failure.
- **AI-5 · User-visible log of what AI did.** Apple ships this as the Apple Intelligence Report. *Here:* tags are rewritten silently; titles appear unattributed; `ai.rs` has no logging. A small `ai_activity` table (note_id, action, model, timestamp) surfaced in the queue popover — also the natural home for future MCP/cloud entries.
- **AI-6 · Ground collection summaries with clickable citations.** NotebookLM's defining trust feature. *Here:* change the summary schema to `[{point, note_ids}]` and link each point to its contributing notes — constrained decoding is already wired.
- ✅ **AI-7 · Version embeddings by model.** Mixed-model vectors fail silently as garbage similarity. *Here:* store the model id in settings; on mismatch at startup, mark embeddings STALE and reuse the existing `reindex_all` sweep. Prerequisite for sqlite-vec and model swaps. *(Shipped June 2026 — vectors are also nulled on mismatch so a half-finished sweep can't mix models in search.)*
- **AI-8 · Disclose per-action cloud usage.** For the planned Clarify feature: label the button cloud-powered, show what will be sent on first use, log to `ai_activity`, keep the rule that the background worker can never route to cloud.
- **AI-9 · MCP server: read-only first, scoped, audited.** Least privilege, per-folder/tag exclusions ("never expose my journal"), enforce the trash invariant in every MCP query path, log agent access, gate writes behind proposed-state ([MCP security practices](https://www.descope.com/blog/post/mcp-server-security-best-practices)).
- **AI-10 · Treat note content as untrusted input.** OWASP LLM01 prompt injection: a pasted web clipping becomes an injection vector once notes flow through MCP into agents holding shell access. Fence note text as data in prompts; say so in MCP tool descriptions.
- **AI-11 · Defer heavy background AI on battery.** Pause Queue-2/sweeps on battery (IOKit / `pmset -g batt`), settings toggle; embedding batches are small enough to leave alone.
- **AI-12 · Per-folder AI opt-out.** A `no_ai` folder flag skipped by queue picks and the future MCP server; composes with the explorer model and doubles as the MCP privacy scope.
- **AI-13 · Mark AI-authored titles until adopted.** Tags have sage + ✨; titles are indistinguishable from typed ones. Subtle sage tint cleared on first user edit.

**Validated as already strong:** bench harness (eval discipline — remaining gap is committing baseline scores per model+prompt-version), structured outputs with fallback parsing, the live `current_activity` breadcrumb, and the proposed-state/consent system (action items, folder suggestions, manual-tag protection, title guard, pre-rewrite snapshots). AI-1 and AI-13 are the only two places content bypasses it.

---

## Lessons from note-taking apps

- ✅ **NOTE-1 · Search-or-create as one gesture** (Notational Velocity, Obsidian quick switcher): Enter on zero results creates a note titled with the query. Nearly free; removes the new-note-then-title dance. *(Shipped June 2026.)*
- ✅ **NOTE-2 · Empty search shows recents.** Most retrieval is "the thing I touched recently." Track MRU (localStorage or a `last_opened_at` column); show in palette/search empty state. *(Shipped June 2026 — `nn.recentNotes` MRU.)*
- ✅ **NOTE-3 · Hybrid search (BM25 + vector + RRF) instead of a mode toggle.** Run FTS5 and cosine in parallel, merge with Reciprocal Rank Fusion ([sqlite-vec hybrid search](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)). A default "smart" mode would beat either engine alone. *(Shipped June 2026 — "smart" is the default; keyword/semantic remain as explicit modes; semantic-only matches carry a ✨ "meaning" badge; degrades to keyword while the embedder warms up.)*
- **NOTE-4 · Propose, never silently rewrite** — same conclusion as AI-1, from the editor-UX side (Tiptap AI Suggestion diff view).
- **NOTE-5 · Capture-first, triage-later** (Drafts). Largely done via ⌘⇧N + auto-title/tag; missing half is a triage cue — unfiled count + one-key file-to-folder.
- **NOTE-6 · Portability = lossless export, not file format.** Apple Notes/Bear prove DB storage is fine. Upgrade the exporter to write YAML front matter (tags, folder, created/updated, pinned, à la [Joplin](https://joplinapp.org/help/dev/spec/interop_with_frontmatter/)) and verify images ship with backups → restore-grade exports, and a future Syncthing-able interchange layer (NOTE-12).
- **NOTE-7 · Restraint is a survival strategy** (Evernote's death by scope creep). Codify the won't-build list — now in `motivations.md` non-goals; mirror a short version in ROADMAP.
- **NOTE-8 · Skip wiki-links; related-notes already gives backlink value without the PKM tax.** Validated existing choice.
- **NOTE-9 · Optional "Open today's note" command** (Logseq/Reflect) — creates a date-titled note in a Journal folder. Notepad-compatible; anything beyond (calendar views) is scope creep.
- **NOTE-10 · The editor's feel is the product** (iA Writer/Bear): missing pieces are a font-choice setting, editor-only focus mode, word count/read time.
- **NOTE-11 · Version history needs a visible diff** more than retention depth — show what changed in the History popover before restoring.
- **NOTE-12 · Cheap sync insurance is already in place** (UUIDs, `updated_at`, soft deletes); the front-matter export folder is the pragmatic sync escape hatch before ever touching CRDTs ([local-first essay](https://www.inkandswitch.com/essay/local-first/)).
- **NOTE-13 · Sync `- [x]` checkboxes with action items** — validates the existing ROADMAP note as the right next step for tasks.
- **NOTE-14 · Attachments handling validated** — relative paths + export-together is already the design; just confirm backups include `images/`.

---

## UI/UX ideas

Ordered by value-for-effort. (6 = AI-1's preview pattern; listed once here for the editor angle.)

1. ✅ **Quick-switcher mode in the palette** — titles first, commands second, recents on empty query, Shift+Enter creates from query. *(Shipped June 2026.)*
2. ✅ **Zero-results "Create '<query>'" row** in SearchBar — every failed search becomes capture. *(Shipped June 2026.)*
3. ✅ **Recency group headers** (Today / Yesterday / Previous 30 days) in search results + relative timestamps on cards. *(Shipped June 2026.)*
4. ✅ **Shortcut hints in palette rows** — the palette teaches the keyboard (Linear pattern). Near-zero cost. *(Shipped June 2026 — every shortcut-backed action is a palette row with its ⌘-hint: new note, quick capture, find in note, toggle sidebar, settings.)*
5. **Word count / read time** in a quiet editor footer or info popover (Bear).
6. ✅ **Inline accept/discard preview for AI rewrites** — sage-tinted proposed text (see AI-1). *(Shipped June 2026.)*
7. **Editor-only focus mode** — one shortcut collapses chrome; typewriter scrolling as phase 2 (iA Writer).
8. **Version-history diff view** — added/removed lines highlighted before restore; reuses stored snapshots.
9. **Outline/ToC popover** built from headings for long notes (Bear Info Panel).
10. **"Open today" command** + Journal folder — plain note, no calendar UI (NOTE-9).
11. **Inbox triage affordance** — unfiled count badge + one-keystroke move-to-folder (FolderPicker already exists).
12. **Hover preview popover** in the file tree (⌘-hover shows first lines; Obsidian page preview).
13. **Pinned Scratchpad convention** — pinned note + a ⌘-Enter timestamp-divider command (Heynote, simplified). Keep it a convention, not a document type.
14. **Section folding on headings** — defer behind the ToC popover, which covers the need cheaper.
15. **Saved searches** ("smart folder lite") — ⚠ first step toward PKM-style views; only if tag filtering proves insufficient, capped at saved queries.

**Desktop UX hygiene checklist** (from the UI/UX guideline pass; applies across all of the above): visible focus rings for full keyboard nav; empty states with a helpful action (search, trash, actions panel); undo toasts for destructive/bulk actions rather than only confirms; respect `prefers-reduced-motion`; 150–300 ms micro-interactions, `ease-out` in / `ease-in` out; skeletons over spinners for >1 s loads; toasts auto-dismiss 3–5 s, never steal focus; maintain ≥4.5:1 text contrast per theme (verify both light and dark ramps independently); tabular figures for counts/dates; one icon family at consistent stroke width (already lucide — keep it).

---

## Performance optimization candidates

Verified against the code at the cited locations. Ordered by impact-for-effort.

| # | Optimization | Where | Impact | Effort |
|---|---|---|---|---|
| ✅ PERF-1 | Move `getMarkdown()` out of `onUpdate` (per keystroke) into the debounced `saveNow()` | `Editor.tsx` ~178 vs ~121 | **High** — typing latency, grows with note size | S |
| ✅ PERF-2 | Async-ify remaining hot sync commands: `update_note`, `list_notes`, `create_note`, `reindex_all`, `save_image_bytes`, `export_notes`, `backup_now` (sync `fn`s run on the main thread; image paste base64-decodes on it today) | `commands.rs` 61, 234, 979, 1144, 1192, 1231 | **High** — removes UI stalls during worker write bursts | S |
| ✅ PERF-3 | `list_notes` returns ~240-char server-side excerpts, not full content (UI only uses 120–220 chars; editor loads via `get_note`); fix `duplicateNote` consumer | `db.rs` 137/205, `store.ts` 127, `Sidebar.tsx` 1017 | **High** at scale — startup, refresh, memory | M |
| ✅ PERF-4 | `React.memo` tree rows; compute hover snippets lazily (`stripMarkdown` runs per row per render today); narrow Sidebar's `queue` subscription | `Sidebar.tsx` 90/1017, `NoteList.tsx` 212 | Med-high — sidebar CPU while worker runs | S |
| PERF-5 | `shouldRerenderOnTransaction: false` + `useEditorState` for SelectionMenu ([Tiptap perf guide](https://tiptap.dev/docs/guides/performance)) | `Editor.tsx` 138, 858 | Med-high — typing latency on large docs | S–M |
| ✅ PERF-6 | Debounce the `note-updated` → `refreshTags()` storm (embed batch = 8 events/tick; sweep = hundreds) | `App.tsx` 42, `queue.rs` 69/271 | Medium — background churn | S |
| ✅ PERF-7 | `PRAGMA synchronous = NORMAL` (WAL-safe; autosave commits 4–6×/save at FULL today) | `db.rs` open() 22–25 | Medium — write latency, db-mutex hold | S |
| PERF-8 | Collapse `queue_status` 4× COUNT(*) into one pass; rate-limit `emit_status` during sweeps | `queue.rs` 26–67 | Low-med | S |
| PERF-9 | Code-split editor bundle: lazy `Editor`, dynamic lowlight grammars (capture window currently parses the full ~1 MB chunk too) | `Editor.tsx` 16/55, `main.tsx`, `App.tsx` 5–12 | Medium — startup ×2 webviews | M |
| PERF-10 | Move embeddings (+ `last_*_input` copies) out of the `notes` row into a side table; stepping stone to sqlite-vec | `db.rs` 40–58; scans in `commands.rs` 272/362/416 | Med now, high at scale | M–L |
| ✅ PERF-11 | Parallelize or merge `extract_actions` with the organize call (serial today, doubles per-note time) — pairs with AI-2 | `queue.rs` 345–359 | Medium — queue drain | M |
| PERF-12 | Quantized embed model (`AllMiniLML6V2Q`, one line) now; evaluate [Model2Vec](https://github.com/MinishLab/model2vec) (~500× faster, no 80 MB download) later — requires AI-7 + re-index, re-tune the 0.80 merge threshold | `embed.rs` 37–42 | Medium — embed throughput, first launch | S / M–L |
| PERF-13 | Batch `get_notes_by_ids` (per-id loop today) and scope `attach_tags` (loads the whole tag table per call) with `IN (...)` | `db.rs` 256–272, 159–184 | Low-med — search/related latency | S |
| PERF-14 | Partial indexes for queue picks (`WHERE status != 'CLEAN' AND deleted_at IS NULL`, ordered by `updated_at`) | `db.rs` 55–58, `queue.rs` 218/304 | Low today, med at 10k+ notes | S |
| PERF-15 | FTS5 `prefix='2 3'` indexes (every search is a prefix query via `fts_query`) — needs one-time rebuild | `db.rs` 67–71, `commands.rs` 246 | Low now, med for large vaults | S |
| ✅ PERF-16 | Set `ready: true` before `refreshNotes()` resolves; let the tree fill in | `store.ts` 111–125 | Low-med — perceived startup | S |
| PERF-17 | Store L2-normalized vectors, use dot product (cosine recomputes norms per pair; `find_similar_notes` is O(n²)) — superseded by sqlite-vec if PERF-10 goes that far | `embed.rs` 90–106 | Low-med — "Tidy up" at 1k+ notes | S |
| PERF-18 | Sidebar virtualization — only matters past ~1–2k visible rows once PERF-3/4 land; fights the tree/drag-drop design | `Sidebar.tsx` 470–488 | Med at large scale only | L |

**Checked and already fine** (don't re-litigate): dev-profile opt-levels; embedder warm-up/phase plumbing; pre-created capture window; async `queue_status` + action commands; the 600 ms autosave architecture itself; the `diff.rs` significant-change gate; FTS5 external-content + triggers; embed batch sizing; 120 ms keyword-search debounce; editor remount per note (`key={noteId}`); WAL + busy_timeout + FK pragmas.
