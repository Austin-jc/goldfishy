# Why the Board doesn't feel like stickies — and how to fix it

A design investigation (June 2026). Diagnosis grounded in the current code, research across sticky/canvas tools, and a concrete proposal: **separate stickies from notes as two different objects, with two-way conversion.**

## 1. Diagnosis: we dressed documents up as stickies

The Board today (`Board.tsx`, `board_clusters`) is an **AI-curated view over notes**: cluster/recent/stale/pinned feeds, rendered as cards in a responsive CSS grid. Each card is a full note — title, tags, summary, AI pipeline, folder, history. That's a genuinely useful surface (a "smart wall of your notes"), but it has none of the properties that make a sticky a sticky:

| Physical sticky property | What it does for thinking | Board today |
|---|---|---|
| **You place it; it stays put** | Position *is* meaning (affinity mapping, spatial memory) | Auto-grid; AI clusters; position is computed, not owned |
| **Small, fixed size** | Forces one thought per sticky; brevity is the feature | Cards grow with content; show todos, summaries, metadata |
| **Color, chosen by hand** | Instant human categorization, zero taxonomy | No color anywhere; sage/clay are reserved system semantics |
| **Cheap to create, cheaper to discard** | Pre-cognitive capture; tossing one is frictionless | Creating = creating a *note* (title, file-ability, AI enrichment); deleting = trash ceremony |
| **Messy, physical** | Feels like material, not records | Uniform grid, uniform styling — reads as a database view |

The mismatch the user sensed is real and structural: **notes are documents** (durable, titled, filed, enriched, searchable for years); **stickies are thoughts** (ephemeral, small, colored, spatially owned, disposable). Projecting one into the costume of the other satisfies neither.

## 2. What the research says

- **Obsidian Canvas is the canonical prior art for the split.** Canvas distinguishes *text cards* (lightweight, markdown, no file behind them, no backlinks/properties) from *note cards* (embedded vault files), and bridges them with right-click → **"Convert to file…"** ([Canvas docs](https://help.obsidian.md/Plugins/Canvas), [Obsidian Rocks guide](https://obsidian.rocks/getting-started-with-canvas-in-obsidian/)). Exactly the two-object + conversion model proposed here.
- **FigJam/Miro stickies codify the physicality**: square/index-card shapes, text grows vertically within a constrained width, hand-arranged position is the point, color is a first-class user property ([FigJam stickies](https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam), [Miro stickies](https://miro.com/stickies-capture/)).
- **Google Keep's lesson**: notes that are "fast, disposable, present-tense" want colored cards, pin/archive, *no folders* — a deliberately different contract from archive apps ([Keep vs. PKM comparison](https://iarchnote.com/index.php/2025/02/10/google-keep-notes-the-beauty-of-minimalism-and-cognitive-load-a-fresh-comparison-with-notion-obsidian-and-logseq/)). Trying to make one object serve both contracts is how apps end up satisfying neither.
- **macOS Stickies (30 years old) survives on three properties**: always visible, spatially scattered by the user (spatial memory recall), zero ceremony ([Stickies history](https://en.wikipedia.org/wiki/Stickies_(Apple)), [guide](https://slashnote.app/blog/macos-sticky-notes-guide/)).
- **2026 AI-UX consensus** (from the Round-2 research in `improvements.md`): the best AI is ignorable until summoned. Stickies are *pre-cognitive* — the one surface where AI should be off by default.

## 3. The conceptual fix

> **A sticky is its own object, not a view of a note.** Notes and stickies convert into each other, explicitly, in both directions.

- **Sticky**: plain text (no title), one of ~6 colors, an owner-placed position on a wall, created and discarded in one gesture. Excluded from the LLM organize pipeline. Indexed for keyword search only (so nothing is ever unfindable), never auto-tagged, auto-titled, or auto-summarized.
- **Note**: unchanged — the durable, AI-enriched document the rest of the app is built around.
- **Promote** (sticky → note): the sticky's text becomes a new note's body; the existing pipeline titles/tags it. The sticky disappears (toast with Open + Undo). This is the "this thought turned out to matter" gesture.
- **Stick** (note → sticky): creates a *linked* sticky — a pointer showing the note's title + a line of its summary, opening the note on double-click (Obsidian's "note card" flavor). The note itself never moves or changes. This is the "keep this on my radar" gesture.

### The Wall

A new Board tab — and the Board's default landing — replacing the sticky *costume* with a sticky *surface*:

- **Fixed-bounds canvas** (scrolls vertically if needed; no zoom, no infinite canvas — see non-goals). Position persisted per sticky.
- **Double-click empty space → sticky appears there, caret ready.** Esc / click-away commits. Empty sticky evaporates.
- **Drag anywhere** (pointer-based per the Tauri DnD constraint; raw pointer handlers, simpler than dnd-kit for free placement). Slight lift shadow while dragging; gentle random rotation (±1.5°) at rest; `prefers-reduced-motion` respected.
- **Width fixed (~200px), text grows vertically; soft cap ~280 chars.** Typing past the cap doesn't block — a quiet "Bigger than a sticky? → Promote to note" affordance appears. The constraint *is* the conversion prompt.
- **Color swatch on hover/context menu** — classic yellow default plus 5 muted-palette options. Color is never assigned by AI.
- **Discard = X with Undo toast** (undo-over-confirm, per house UX conventions — stickies are cheap, restoring must be too).
- **Quick capture integration**: the capture window (⌘⇧N) gets a "sticky" toggle — fleeting thoughts land on the Wall instead of becoming untitled notes the AI then dutifully titles and tags (today's pipeline applies document ceremony to non-documents).

### What happens to the existing Board modes

Clusters / Recent / Stale / Pinned stay — they're good *views*. But they stop pretending to be stickies:

- Re-labeled as what they are (e.g. tab group "Views" next to "Wall"), restyled as flat cards (current styling is fine), so the sticky visual language is reserved for actual stickies.
- The semantic-correction machinery (`board_links`, sticky human placements vs. computed clusters) is untouched — it belongs to the Clusters view and remains one of its best ideas.

### AI stance on the Wall

Off by default; summonable, review-first, one-shot:

- **"Tidy the wall"** (explicit button): proposes a spatial grouping of stickies as a preview overlay — accept or dismiss; never runs in the background, never moves a sticky silently (same consent pattern as auto-arrange).
- **"Roll up"**: turn a hand-made cluster of stickies into one note (bullets = stickies), consuming them — the digital version of collecting the whiteboard after a workshop.

## 4. Data model & touchpoints (sketch)

```sql
CREATE TABLE stickies (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow',
  x REAL NOT NULL, y REAL NOT NULL,
  z INTEGER NOT NULL DEFAULT 0,        -- raise on drag
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,  -- non-null = linked sticky
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- Commands: `list_stickies`, `create_sticky`, `update_sticky` (text/color/position), `delete_sticky` (+ restore for Undo), `promote_sticky` (→ note, runs through `create_note`/`update_note` so the pipeline takes over), `stick_note` (note → linked sticky).
- FTS: index `stickies.text` in a small separate FTS table surfaced in keyword search results with a sticky glyph; skip embeddings entirely (semantic search over 12-word thoughts adds nothing and costs a pipeline exception).
- Queue/AI: no changes — stickies never enter Queue 1/2. The trash invariant doesn't apply (stickies bypass trash; Undo toast covers the regret window).
- Frontend: `Wall.tsx` (new), Board tab wiring, capture-window toggle, note context-menu "Stick to wall", sidebar drag → wall is *not* needed in v1 (context menu covers it; cross-DndContext drag is real complexity for marginal gain).

## 5. Deliberate non-goals

- **No infinite canvas, no zoom, no connectors/arrows, no multiplayer** — that's FigJam/Miro territory and the fastest way to violate the "supercharged notepad, not a whiteboard suite" boundary in `motivations.md`.
- **No sticky folders/tags/labels.** A wall that needs an org system has notes on it — promote them.
- **No multiple walls in v1.** One wall keeps spatial memory honest (and matches a physical monitor edge). Revisit only if real use demands it.
- **No rich text on stickies** beyond what plain markdown rendering gives for free. Headings on a sticky are a note begging to exist.

## 6. Phased plan

| Phase | Scope | Size |
|---|---|---|
| 1 | `stickies` table + CRUD commands; Wall tab with double-click create, free drag, colors, discard+undo; promote-to-note; note→linked-sticky via context menu | M |
| 2 | Capture-window "sticky" toggle; keyword-search surfacing; over-cap promote nudge; visual polish (rotation, lift, reduced-motion) | S |
| 3 (opt-in) | "Tidy the wall" proposal overlay; "Roll up" cluster→note; sticky reminders | M |

**Sources:** [Obsidian Canvas](https://help.obsidian.md/Plugins/Canvas) · [Obsidian Rocks: Getting started with Canvas](https://obsidian.rocks/getting-started-with-canvas-in-obsidian/) · [FigJam sticky notes](https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam) · [Miro stickies capture](https://miro.com/stickies-capture/) · [Google Keep design comparison](https://iarchnote.com/index.php/2025/02/10/google-keep-notes-the-beauty-of-minimalism-and-cognitive-load-a-fresh-comparison-with-notion-obsidian-and-logseq/) · [Apple Stickies (Wikipedia)](https://en.wikipedia.org/wiki/Stickies_(Apple)) · [SlashNote: Mac sticky notes guide](https://slashnote.app/blog/macos-sticky-notes-guide/)
