# Iteration context — Stickies/Wall + June 2026 improvements

A handoff for picking up these features in a fresh session. It maps the code,
records the design invariants you must not break, and lists the open tuning
knobs and next steps. Pairs with the deeper design rationale in
[`board-stickies-redesign.md`](board-stickies-redesign.md) and the audit backlog
in [`improvements.md`](improvements.md) — this doc is the "where things are / how
to continue" layer, not a re-derivation.

Repo: `/Users/avocado/notepai` (GitHub remote moved to `Austin-jc/goldfishy`;
pushing to the old `notepai` URL still works via redirect — the warning is
harmless). Stack: Tauri 2 + React 19 + Zustand + Tiptap + rusqlite. All work
below is committed on `main` (range `c6ed101..HEAD`).

---

## 1. Run & test recipes

- **Run the real app:** `npm run tauri dev` (compiles the Rust binary, opens a
  native window). The Wall is the default Board tab — open with **⌘⇧B**.
- **Typecheck / build the frontend:** `npx tsc --noEmit` and `npm run build`
  (build runs `tsc && vite build`).
- **Check the backend:** `cd src-tauri && cargo check`.
- **Headless screenshot of a component** (used throughout this work, since the
  Tauri window can't be driven headlessly): create `wall-preview.html` +
  `src/wall-preview.tsx` that seed the Zustand store (`useStore.setState({…})`)
  and render the component, then:
  ```bash
  (npm run dev &) ; sleep 4
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --hide-scrollbars --window-size=1120,720 \
    --virtual-time-budget=4000 --screenshot=/tmp/x.png \
    http://localhost:1420/wall-preview.html
  ```
  Tauri `invoke` throws outside the app but the store actions catch it, so
  pre-seeded state survives. **Delete the harness files after** — they must not
  be committed. Store-backed state (e.g. `stickyHint`, `stickyResults`) can be
  seeded directly; component-internal state (selection, tidy preview) cannot.
- **SQL smoke test** (verifies migrations/FTS without the app): pipe the schema
  into `sqlite3 :memory:` and run sample inserts/searches — see Phase 2a's commit
  for the exact script.

**Testing gap to know:** compile + SQL + screenshots were the verification level.
The *live drag-persist round-trips and embedding-dependent results* (clustering
quality, hint matches, search relevance) were NOT exercised against a running
backend — they need `tauri dev`. The two thresholds in §4 are first-guess values.

---

## 2. The Stickies feature — what & why

A **sticky** is its own object, distinct from a **note**. Notes are documents
(durable, titled, filed, AI-enriched); stickies are thoughts (ephemeral, small,
colored, spatially owned, disposable). They convert both ways. Full rationale +
research in `board-stickies-redesign.md`. Shipped in three phases:

- **Phase 1** — the Wall (free-drag canvas), Inbox, colors, double-click create,
  inline edit, discard+Undo, promote (sticky→note), stick (note→linked sticky),
  ⌘⇧K capture.
- **Phase 2** — text stickies embedded for search (Queue 1 + FTS, never the LLM
  pipeline); search surfaces a "Stickies" group; capture-window Note/Sticky
  toggle.
- **Phase 3** — multi-select + Roll up; "Tidy the wall" (review-first); opt-in
  ambient "similar sticky" hints.

### Design invariants (do not break these)

1. **Embed-yes / LLM-no.** Text stickies ride Queue 1 (local embeddings) but
   NEVER Queue 2 (titling/tagging/summarizing). A sticky has `embedding_status`
   and **no `llm_status`**. This asymmetry *is* "a thought, not a document."
2. **The system never fakes spatial intent.** Off-Wall captures (⌘⇧K, capture
   window, note→stick) land in the **Inbox** (`placed = 0`), not at a guessed
   x/y. Only a pointed gesture (double-click, drag-drop) sets `placed = 1`.
3. **AI on the Wall is summonable or opt-in, never silent.** Tidy previews
   before moving anything (Keep/Revert). Ambient hints are off by default.
   Linked stickies never embed (they mirror an already-indexed note).
4. **Undo over confirm** for discards (stickies are cheap). They bypass the
   notes trash entirely; the Undo toast is the whole safety net.
5. **Pointer-based DnD only.** HTML5 drag is dead in the Tauri webview. The Wall
   uses raw pointer handlers (not dnd-kit — free placement doesn't fit its
   sortable model). The sidebar/Board/arrange-modal use dnd-kit pointer sensors.

---

## 3. Code map

### Backend (`src-tauri/src/`)
- **`db.rs`** — `stickies` table + `stickies_fts` mirror + triggers in
  `migrate()` (additive ALTERs for the Phase-2 embedding columns; one-time FTS
  `'rebuild'`). Helpers: `row_to_sticky`, `get_sticky`, `list_stickies`,
  `next_sticky_z`, `STICKY_SELECT` (the LEFT JOIN that resolves a linked
  sticky's live `note_title`/`note_preview`).
- **`commands.rs`** — all sticky commands (search for `// ---- stickies`):
  `list_stickies`, `create_sticky`, `update_sticky` (COALESCE partial update;
  a move bumps z to front; a text change re-stales the embedding),
  `delete_sticky`/`restore_sticky` (hard delete + re-insert for Undo),
  `promote_sticky`, `roll_up_stickies`, `stick_note`, `search_stickies`
  (keyword FTS + semantic cosine + smart RRF, mirrors `search_notes`),
  `cluster_stickies` (union-find over embeddings → `Vec<Vec<id>>`),
  `similar_sticky` (on-demand cosine, returns the top match or null).
  Thresholds: `STICKY_CLUSTER_THRESHOLD = 0.55`, `STICKY_SIMILAR_THRESHOLD = 0.62`.
- **`queue.rs`** — "Queue 1b" step embeds STALE text stickies (`note_id IS NULL`,
  non-empty); the sweep-done check waits on pending sticky embeddings.
- **`models.rs`** — `Sticky` struct (Serialize+Deserialize; `note_title`/
  `note_preview`/`score`/`snippet`/`matched_by` are `#[serde(default)]`).
  `AppSettings.sticky_ambient_hints: bool` (default false; struct has
  `#[serde(default)]` so new fields are upgrade-safe).
- **`lib.rs`** — the `invoke_handler!` registration list (all 11 sticky commands).

### Frontend (`src/`)
- **`components/Wall.tsx`** — the whole Wall. Key constants: `STICKY_W = 172`,
  `DRAG_THRESHOLD = 4`, `SOFT_CAP = 280`, `COLORS` (7), `COLOR_BG` map,
  `computeTidyLayout()` (groups → column positions). Internal state: drag
  session (refs to dodge stale closures), `editingId`, `pulsingId`, `selected`
  (Set), `tidyPreview`. `StickyCard` is a memoized subcomponent (renders text/
  linked/editing, hover toolbar, color popover, dog-ear, pulse, selection ring).
- **`store.ts`** — sticky state (`stickies`, `stickiesLoaded`, `focusStickyId`,
  `highlightStickyId`, `stickyHint`, `stickyResults`) and actions
  (`refreshStickies`, `createSticky`, `saveSticky` [optimistic; triggers the
  ambient hint when `fields.text` changed + setting on], `discardSticky`,
  `discardStickies`, `promoteSticky`, `rollUpStickies`, `applyStickyLayout`,
  `stickNoteToWall`, `quickCaptureSticky`, `openWallToSticky`,
  `dismissStickyHint`, `mergeStickyHint`).
- **`api.ts`** — sticky bindings (the `// stickies (the Wall)` block).
- **`types.ts`** — `Sticky`, `StickyColor`, `BoardMode` (now includes `"wall"`).
- **`components/Board.tsx`** — the "Wall" tab (default), renders `<Wall/>`.
- **`components/Sidebar.tsx`** — `StickyResultRow` + the "Stickies" search group;
  note context-menu "Stick to wall". (`SPRING_OPEN_MS = 650` lives here too.)
- **`components/Editor.tsx`** — selection-menu "Stick to wall".
- **`components/CaptureWindow.tsx`** — Note/Sticky toggle (localStorage
  `nn.captureMode`); emits `sticky-captured`.
- **`App.tsx`** — ⌘⇧K binding; `sticky-captured` listener.
- **`components/SettingsModal.tsx`** — "The Wall" section → ambient-hints toggle.

---

## 4. Open tuning knobs & deferred work

**Most likely to need tuning** (first-guess values for short-text embeddings —
validate against real stickies in `tauri dev`):
- `STICKY_CLUSTER_THRESHOLD = 0.55` (Tidy grouping). Too high → everything is a
  singleton; too low → one giant blob.
- `STICKY_SIMILAR_THRESHOLD = 0.62` (ambient hint). Too low → noisy nags.
- `computeTidyLayout` uses a fixed `slotH = 100` row height; real sticky heights
  vary, so tall stickies can overlap. Consider measuring actual heights.

**Deferred (designed, not built):**
- **Sticky reminders** — would reach into the action-items/reminder system; left
  out as lowest-value / most scope creep.
- **⌘⇧K "place at viewport center when the Wall is open"** — currently always
  Inbox (a keyboard capture isn't a pointed placement). The viewport-aware
  variant is noted in the design as a polish item.
- **"Views" sub-grouping** — Clusters/Recent/Stale/Pinned still sit as a flat tab
  group next to Wall (divider only), not a nested "Views" menu (purely cosmetic).

**Natural next ideas:** group-move of a multi-selection; lasso select; sticky
templates/quick colors; per-Wall zoom-to-fit; export the Wall.

---

## 5. Other June-2026 work (brief, with pointers)

Curated from a research+audit round (`improvements.md` → "Round 2 / Next top 10").
Each shipped as its own commit:

- **File explorer:** subtree-wide drop targets (`e477c35`); spring-loaded folders
  (`f86da0d`).
- **Editor:** version-history **diff view** before restore (`bfdce5b`); word
  count / read time footer (`d0e9932`); per-keystroke re-render fix (`0211f4b`).
- **Navigation:** **Open today's note ⌘J** (`1ef08e5`); **Focus mode ⌘⇧F**
  (`2157ae1`).
- **AI/cleanup:** manual **Summarize-missing** trigger (`e6a795b`); AI error
  states with live retry countdown (`91e5eef`).
- **A11y/polish:** focus rings + ARIA menu roles + 4s confirms (`fd092c3`).
- **Perf:** background-churn reduction (`68d8e62`); code-split bundle (`51dc677`).

---

## 6. Gotchas

- **Push warning** "This repository moved" is benign (old remote redirects).
- **Settings migrations:** add new `AppSettings` fields with a value in the
  `Default` impl — the struct's `#[serde(default)]` keeps old saved settings from
  resetting on upgrade.
- **rusqlite borrow lifetimes:** when collecting a `query_map`, bind the mapped
  iterator to a `let` before `.collect()` (a one-liner trips an E0597 on the
  `stmt` borrow — see `cluster_stickies`).
- **Tauri arg naming:** JS passes camelCase; Rust receives snake_case
  (`{ noteId }` → `note_id`). Single-word args are identical.
- **Conventions:** `docs/conventions.md` (golden rules — e.g. prompts live in
  `prompts/prompts.json`, single source); `docs/architecture.md`; `HANDOFF.md`.
  AI/UX house rules: AI work runs in the background + "ready for review"; 2-stage
  button confirms, never blocking modals; AI must be ignorable.
