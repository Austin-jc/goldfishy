# Stickies ≠ Notes — Wall redesign

A design for separating **stickies** (ephemeral, spatial thoughts) from **notes** (durable, AI-enriched documents), with explicit two-way conversion. v2 (2026-06-17) locks the open decisions from v1's investigation; v1's diagnosis and research are preserved in §1–2.

## Decisions locked (2026-06-17)

| Question | Decision |
|---|---|
| **Capture paths** | All four: global quick-capture window, double-click the Wall, from a note/selection, and an in-app keyboard shortcut. Stickies are a first-class *capture target*, not just a Wall feature. |
| **Storage** | Own `stickies` table, **fully searchable** — text stickies ride the cheap local **embedding** pass so they appear in semantic search; they never enter the **LLM** pass (no auto-title/tag/summary). |
| **Wall spatiality** | Free placement on a fixed-width wall that scrolls vertically. Owned x/y, no zoom, no infinite canvas. |
| **AI** | Summonable actions always available ("Tidy the wall", "Roll up"). Ambient hints (similar-sticky detection) off by default, behind a Settings toggle. |

The two consequential follow-ons these created — *where off-Wall captures land* and *the embed-yes / LLM-no split* — are resolved in §3.3 (the **Inbox**) and §3.2.

---

## 1. Diagnosis: we dressed documents up as stickies

The Board today (`Board.tsx`, `board_clusters`) is an **AI-curated view over notes**: cluster/recent/stale/pinned feeds rendered as cards in a responsive grid. Each card is a full note — title, tags, summary, AI pipeline, folder, history. A useful surface (a "smart wall of your notes"), but with none of the properties that make a sticky a sticky:

| Physical sticky property | What it does for thinking | Board today |
|---|---|---|
| **You place it; it stays put** | Position *is* meaning (affinity mapping, spatial memory) | Auto-grid; AI clusters; position is computed, not owned |
| **Small, fixed size** | Forces one thought per sticky; brevity is the feature | Cards grow with content; show todos, summaries, metadata |
| **Color, chosen by hand** | Instant human categorization, zero taxonomy | No color anywhere; sage/clay are reserved system semantics |
| **Cheap to create, cheaper to discard** | Pre-cognitive capture; tossing one is frictionless | Creating = creating a *note* (title, file-ability, AI enrichment); deleting = trash ceremony |
| **Messy, physical** | Feels like material, not records | Uniform grid, uniform styling — reads as a database view |

The mismatch is real and structural: **notes are documents** (durable, titled, filed, enriched, searchable for years); **stickies are thoughts** (ephemeral, small, colored, spatially owned, disposable). Projecting one into the costume of the other satisfies neither.

## 2. What the research said

- **Obsidian Canvas is the canonical prior art for the split.** It distinguishes *text cards* (lightweight markdown, no file behind them, no backlinks/properties) from *note cards* (embedded vault files), bridged by right-click → **"Convert to file…"** ([Canvas docs](https://help.obsidian.md/Plugins/Canvas), [Obsidian Rocks guide](https://obsidian.rocks/getting-started-with-canvas-in-obsidian/)). Exactly the two-object + conversion model here.
- **FigJam/Miro stickies codify the physicality**: index-card shapes, text grows vertically within a constrained width, hand-arranged position is the point, color is a first-class user property ([FigJam](https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam), [Miro](https://miro.com/stickies-capture/)).
- **Google Keep's lesson**: notes that are "fast, disposable, present-tense" want colored cards, pin/archive, *no folders* — and a fresh capture lands in a known place (top of the grid), not wherever the system guesses ([Keep vs PKM comparison](https://iarchnote.com/index.php/2025/02/10/google-keep-notes-the-beauty-of-minimalism-and-cognitive-load-a-fresh-comparison-with-notion-obsidian-and-logseq/)). This directly justifies the Inbox (§3.3).
- **macOS Stickies (30 years old)** survives on three properties: always visible, spatially scattered *by the user*, zero ceremony ([Stickies history](https://en.wikipedia.org/wiki/Stickies_(Apple))).
- **2026 AI-UX consensus** (Round-2 research in `improvements.md`): the best AI is ignorable until summoned. Stickies are *pre-cognitive* — the surface where AI defaults off.

## 3. The design

> **A sticky is its own object, not a view of a note.** Notes and stickies convert into each other, explicitly, in both directions.

### 3.1 The two objects

- **Sticky**: plain text (no title), one of ~6 hand-chosen colors, an owner-placed position on the Wall. Created and discarded in one gesture. Two flavors:
  - **Text sticky** — owns its text. Embedded for search; never LLM-processed.
  - **Linked sticky** — a pointer to a note (`note_id` set). Shows the note's title + one summary line; double-click opens the note. Owns no text, so it is *not* embedded (the note already is). This is Obsidian's "note card."
- **Note**: unchanged — the durable, AI-enriched document the rest of the app is built around.

### 3.2 The embed-yes / LLM-no split (storage decision, made precise)

"Fully searchable" must not smuggle document-ceremony back onto stickies. The app already runs two independent pipelines (`queue.rs`): **Queue 1** = local embeddings (cheap, fast); **Queue 2** = LLM (titling, tagging, routing, summarizing). The split:

- Text stickies **enter Queue 1 only** → semantic + keyword search, and the cosine signal that powers ambient hints (§3.6). Cheap, local, on-device — consistent with the standing principle that automatic work stays local.
- Stickies **never enter Queue 2** → no titles, no tags, no folder routing, no summaries. The worker's Queue-2 pick query simply never sees them (separate table).
- Linked stickies enter neither pipeline.

So a sticky has `embedding` / `embedding_status` columns but no `llm_status`. That single asymmetry is the entire technical expression of "a thought, not a document."

### 3.3 The Wall, and where captures land (the Inbox)

A new Board surface — and the Board's default landing:

- **Fixed-width canvas, scrolls vertically.** No zoom, no pan-infinite. Each sticky's x/y is persisted; `z` raises on drag (bring-to-front).
- **Inbox strip** — a thin tray pinned to the top of the Wall holding **unplaced** stickies (`placed = 0`). Because three of the four capture paths happen while the Wall isn't even visible, the system must never fake spatial intent. Off-Wall captures pile into the Inbox in a known place (the Keep "new-to-top" pattern); dragging one down onto the wall sets `placed = 1` and is the act of placing it. The Inbox makes "not yet placed" a real, visible place rather than a guessed coordinate.

Placement rules by capture path:

| Path | Trigger | Lands |
|---|---|---|
| Double-click empty wall | in-app, Wall open | **Placed** at the click point, caret ready |
| In-app shortcut | ⌘⇧K, Wall open | **Placed** near viewport center, focused |
| In-app shortcut | ⌘⇧K, Wall closed | Inbox (opens the Wall) |
| Global quick-capture | ⌘⇧N window + sticky toggle | Inbox |
| From a note / selection | context menu "Stick to wall" | Inbox (linked or text sticky) |

(The viewport-aware "placed vs Inbox" rule is tunable; the invariant is: *the system places a sticky only when you pointed at where it goes.*)

### 3.4 Capture, in detail

- **Double-click the Wall** → sticky appears there, caret ready. Esc / click-away commits; an empty sticky evaporates.
- **Global quick-capture (⌘⇧N)** — the existing capture window gains a **note ⇄ sticky toggle** (remembers last choice). Sticky mode skips note creation entirely and drops to the Inbox. This fixes today's real wart: a fleeting thought captured via ⌘⇧N currently becomes an untitled *note* the LLM then dutifully titles and tags — document ceremony applied to a non-document.
- **In-app keyboard (⌘⇧K)** — drops a sticky per the table above. One dedicated shortcut straight to sticky capture, no window switch.
- **From a note / selection** — note context-menu (and editor text-selection menu) → **"Stick to wall"**. A note becomes a *linked* sticky; a text selection becomes a *text* sticky. The source note never moves or changes.

### 3.5 Manipulation & feel

- **Drag anywhere** (pointer-based — HTML5 DnD is dead in the Tauri webview; raw pointer handlers are simpler than dnd-kit for free placement). Slight lift shadow while dragging; gentle rest rotation (±1.5°); `prefers-reduced-motion` respected.
- **Width fixed (~200px), text grows vertically; soft cap ~280 chars.** Typing past the cap never blocks — a quiet **"Bigger than a sticky? → Promote to note"** affordance appears. The size constraint *is* the conversion prompt.
- **Color** via hover swatch / context menu — classic yellow default + 5 muted-palette options. Never assigned by AI.
- **Discard = X with an Undo toast** (undo-over-confirm, per house UX conventions — stickies are cheap, so restoring one must be too). Stickies bypass the notes trash entirely; the Undo window is the whole safety net.

### 3.6 Conversions

- **Promote** (sticky → note): the sticky's text becomes a new note's body; the existing pipeline titles/tags/summarizes it. The sticky is consumed (toast: Open · Undo). The "this thought turned out to matter" gesture.
- **Stick** (note → linked sticky): §3.4. The "keep this on my radar" gesture.
- **Roll up** (cluster of stickies → one note): collects a hand-made group into a single note (each sticky a bullet), consuming them — the digital "collect the whiteboard after the workshop." Summonable button; never automatic.

### 3.7 AI stance on the Wall

- **Off by default.** Summonable, review-first, one-shot:
  - **"Tidy the wall"** — proposes a spatial grouping of stickies as a preview overlay; accept or dismiss; never moves a sticky silently (same consent pattern as auto-arrange). Reuses the clustering machinery already behind `board_clusters`, now over sticky embeddings.
  - **"Roll up"** — §3.6.
- **Ambient hints** (Settings toggle, default off): as you drop or edit a sticky, a cheap cosine check against other stickies surfaces a dismissible *"similar to: …"* hint with a jump/merge affordance. Powered by the Queue-1 embeddings — no extra model, no cloud. This is the one place ambient AI is allowed, and only because the user opted in.

### 3.8 Search integration

A keyword/semantic search now returns both notes and stickies. Stickies carry a small sticky glyph in results; selecting one **opens the Wall and centers/pulses that sticky**. This reinforces that the Wall is a real, reachable surface, not a dead-end view.

### 3.9 What happens to today's Board modes

Clusters / Recent / Stale / Pinned are good *views over notes* — they stay, but stop pretending to be stickies:

- Re-grouped under a "Views" tab next to "Wall", restyled as flat note cards (current styling is fine), so the sticky visual language is reserved for actual stickies.
- The semantic-correction machinery (`board_links` — human placements overriding computed clusters) is untouched; it belongs to the Clusters view and remains one of its best ideas.

## 4. Data model & touchpoints

```sql
CREATE TABLE stickies (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow',
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  z INTEGER NOT NULL DEFAULT 0,          -- raise on drag
  placed INTEGER NOT NULL DEFAULT 0,     -- 0 = in Inbox, not yet hand-placed
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,  -- non-null = linked pointer
  embedding BLOB,                        -- text stickies only
  embedding_status TEXT NOT NULL DEFAULT 'STALE',  -- linked stickies stay CLEAN (no-op)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- + a small stickies_fts mirror for keyword search
```

- **Commands**: `list_stickies`, `create_sticky`, `update_sticky` (text/color/x/y/z/placed), `delete_sticky` (+ `restore_sticky` for Undo), `promote_sticky` (→ note via `create_note`/`update_note` so the pipeline takes over), `stick_note` (note → linked sticky), `stick_text` (selection → text sticky).
- **Worker**: Queue 1 picks up `embedding_status = 'STALE'` stickies alongside notes (text stickies only). Queue 2 untouched. The trash purge/invariant doesn't apply to stickies.
- **Frontend**: `Wall.tsx` (new) + Inbox strip; Board tab wiring ("Wall" | "Views"); capture-window note⇄sticky toggle; ⌘⇧K binding; note context-menu + editor selection-menu "Stick to wall"; search-result sticky rendering + center-on-Wall; Settings toggle for ambient hints.

## 5. Deliberate non-goals

- **No infinite canvas, no zoom, no connectors/arrows, no multiplayer** — FigJam/Miro territory; the fastest way to violate the "supercharged notepad, not a whiteboard suite" boundary in `motivations.md`.
- **No sticky folders/tags/labels.** A wall that needs an org system has *notes* on it — promote them.
- **No multiple walls in v1.** One wall keeps spatial memory honest (and matches a physical monitor edge). Revisit only if real use demands it.
- **No rich text** beyond what plain markdown rendering gives for free. A heading on a sticky is a note begging to exist.
- **No LLM pipeline on stickies, ever.** Embeddings (local) yes; titles/tags/summaries no.

## 6. Phased plan

| Phase | Scope | Size |
|---|---|---|
| 1 ✅ | `stickies` table + CRUD; Wall tab with double-click create, free drag, colors, discard+Undo; the Inbox; promote-to-note; note/selection → sticky; ⌘⇧K | M |
| 2 ✅ | Queue-1 embedding of text stickies; semantic+keyword search surfacing (glyph + center-on-Wall); capture-window note⇄sticky toggle; over-cap promote nudge; visual polish (lift, reduced-motion) | M |
| 3 ✅ | "Tidy the wall" proposal overlay; "Roll up" cluster→note; Settings ambient-hints toggle + similar-sticky detection (sticky reminders deferred) | M |

**Phase 1 shipped (2026-06-17).** Notes:
- Soft cap (280 chars) shows the "Promote to note" nudge inside the editing sticky; rotation (±1.6°, reduced-motion aware) and lift shadow are in already.
- ⌘⇧K lands in the Inbox (a keyboard capture isn't a pointed placement) and opens the Wall in edit mode on it — the "viewport-center when Wall open" nuance is left for Phase 2.
- Dropping a placed sticky onto the Inbox strip sends it back to the Inbox (`placed = false`).
- Today's `Clusters/Recent/Stale/Pinned` stay as a tab group; the Wall is set apart from them with a divider rather than a full "Views" sub-grouping (deferred — purely cosmetic).
- Polish (2026-06-18): text stickies hug their content; linked stickies carry a folded-corner "dog-ear" so they read as note-pointers regardless of color.

**Phase 2 shipped (2026-06-18).** Notes:
- Text stickies ride Queue 1 (local embeddings) + a `stickies_fts` mirror; they never touch Queue 2 (no `llm_status`). Linked stickies are excluded (the note they point at is already indexed). The embed/LLM split from §3.2 is now real in code.
- `search_stickies` mirrors the note search (keyword / semantic / smart-RRF); the sidebar shows a "Stickies" group above "Notes" with a color dot, a ✨ meaning badge for semantic-only hits, and a snippet. Clicking opens the Wall and pulses the sticky into view.
- The capture window (⌘⇧N) gained a persisted Note/Sticky toggle; sticky mode drops straight into the Inbox via `sticky-captured`.
- Verified: a SQLite smoke test exercised the FTS insert/update/delete triggers + bm25 search; the search-results group was screenshot-verified; tsc + vite build + cargo check all green.

**Phase 3 shipped (2026-06-19).** The AI-on-the-Wall layer — summonable + opt-in, never silent:
- **Multi-select + Roll up** (3a): modifier-click selects stickies (accent ring); a floating bar rolls the selection into one note (`roll_up_stickies`, bullets in top-to-bottom order, consumes them) or bulk-discards with a single Undo.
- **Tidy the wall** (3b): `cluster_stickies` (union-find over embeddings, 0.55 floor) groups stickies; the frontend lays groups into columns and *previews* the move (animate-to-position, board frozen) with Keep/Revert — never persisted until Keep. Same consent pattern as auto-arrange.
- **Ambient hints** (3c): Settings → The Wall toggle (default off). On a sticky text-commit, `similar_sticky` does an on-demand cosine over the local sticky index; a near-duplicate (>0.62) surfaces a dismissible sage hint (Jump / Merge / Dismiss). The one ambient-AI touch on the Wall, gated behind explicit opt-in.
- **Deferred**: sticky reminders (would reach into the action-items/reminder system — lowest value, most scope creep; not built).
- Verified: cargo check + tsc + vite build green throughout; the Tidy button, selection, and the hint bar were screenshot-confirmed.

**Sources:** [Obsidian Canvas](https://help.obsidian.md/Plugins/Canvas) · [Obsidian Rocks: Getting started with Canvas](https://obsidian.rocks/getting-started-with-canvas-in-obsidian/) · [FigJam sticky notes](https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam) · [Miro stickies capture](https://miro.com/stickies-capture/) · [Google Keep design comparison](https://iarchnote.com/index.php/2025/02/10/google-keep-notes-the-beauty-of-minimalism-and-cognitive-load-a-fresh-comparison-with-notion-obsidian-and-logseq/) · [Apple Stickies (Wikipedia)](https://en.wikipedia.org/wiki/Stickies_(Apple)) · [SlashNote: Mac sticky notes guide](https://slashnote.app/blog/macos-sticky-notes-guide/)
