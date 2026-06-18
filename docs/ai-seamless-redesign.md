# Making the AI integrations seamless

An audit of every AI surface in GoldFishy today, the friction that keeps it from feeling like one coherent system, and a spec to fix it. The AI *quality* and the *engine* are not the problem — the **surface** is inconsistent. The fix is to unify everything around the three patterns the app already gets right (background + Review toast, sage `✨` provenance, review-before-apply), not to add new AI.

Scope agreed (2026-06-17): all four directions — **A** consistency pass, **B** inline editor AI, **C** consolidate entry points, **D** transparency / activity log. Spec first, then code.

> Guard rails this spec inherits from `conventions.md` and must never break:
> - **Consent ladder** — silent is OK *only* for additive, reversible metadata (tags, titles on untitled notes). Anything that moves/schedules/rewrites needs an explicit Accept or a keep/discard preview; rewrites snapshot first (golden rule 4).
> - **Local by default** — the automatic background pipeline only ever uses the local backend. Nothing here changes that.
> - **AI must be ignorable** — the 2026 consensus the app is built on. Seamless ≠ louder. Every change below either *reduces* interruption or keeps it constant.
> - **Idle-respecting, never blocking** — background after typing stops; results fade in; no modal steals focus.

---

## 1. Diagnosis: a strong engine behind an inconsistent storefront

The background engine is excellent and well-instrumented (dual-queue, diff-gated, one combined `organize_note` call, live status footer). What undermines the feel is everything *around* the trigger and the result. Five structural problems, each verified in code.

### 1.1 Two different execution models for the same class of action

Bulk/library actions split into two incompatible behaviors:

| Pattern | Ops | Behavior | Feel |
|---|---|---|---|
| **Background + Review** (good) | auto-arrange, find-similar/tidy, collection summary | plan runs in the background via `store.ts` watchers (`store.ts:474-498`); a toast with **Review** fires when ready; survives navigation | non-blocking, consent-first — the app's best AI UX |
| **Blocking `await`** (bad) | `aiTitleUntitled`, `aiSummarizeMissing`, `aiRetagAll` | the palette/sidebar handler `await`s the whole sweep, then toasts a count (`CommandPalette.tsx:142-193`, `Sidebar.tsx:582-621`) | on a large library the UI sits on a bare spinner with no progress; **directly violates the locked convention** *"AI work runs in background + ready-for-review notification, never blocking"* |

Same category of work (operate on many notes), two opposite consent/feedback models, sitting in the *same menu*. This is the single biggest seam.

### 1.2 The editor's "Organize" button is the weakest-feedback action in the app

`Editor.tsx:462` runs `aiProcessNote` and surfaces **nothing** — no toast, no confirmation. The spinner stops; the user has to *notice* new tags or scroll to the folder banner to know it did anything. It sits between two well-instrumented buttons (Auto-bullet → preview modal; Extract actions → panel + count toast), so the uniform look hides three completely different result behaviors. Two further problems with this exact button:

- The labels collapse to icon-only below 700px header width (`Editor.tsx:103,416`) → three near-identical sparkle/list glyphs.
- It calls the **old split code path** (`generate_title` + `auto_tag_and_route`, `commands.rs:1280-1296`) — *not* `organize_note`, which is what the background queue runs (`queue.rs:336`). So the manual "Organize" and the automatic organize can produce different results from the same note. A correctness seam hiding inside a UX seam.

### 1.3 The same capability lives in three or four places

| Capability | Entry points today | Result surfacing varies? |
|---|---|---|
| Extract actions | Editor header button + ActionPanel "Scan note" | yes (toast+panel vs. silent in-panel) |
| Find-similar / Tidy | sidebar button + palette + the modal's own re-scan | yes |
| Auto-arrange | sidebar button + palette + the modal's own re-plan | yes |
| Auto-title untitled | sidebar button + palette | execution model differs (both blocking) |
| Summarize missing | sidebar button + palette | both blocking |

There is no single answer to "where does AI live?" — and because the surfacing differs per entry point, muscle memory never forms. (The field consensus the app already cites: *every action reachable the same way builds the mental model;* `improvements.md` Round-2.)

### 1.4 A naming collision between two unrelated features

- **"Tidy board"** (`Board.tsx`) = re-run semantic clustering of the Board.
- **"Tidy up similar notes"** (`Sidebar.tsx:623`) = find near-duplicate notes and offer to *merge* them (destructive-ish — sources go to Trash).

Same verb, totally different stakes. A user who learns one will mis-predict the other.

### 1.5 Automatic AI is invisible, and its off-switch is buried

The bulk of AI activity — auto-tag, auto-title, summary, action extraction, embedding — is *automatic and silent* by design (correct!), surfaced only by tiny pulse dots and `✨` markers. But:

- There is **no record of what the AI did** (`improvements.md` AI-5 is still open; `ai.rs` has no activity logging). Silent + no log = the user can't audit or trust it, only react when something looks off.
- The fact that it's automatic, and that **Manual Only mode silently turns the whole pipeline off**, is explained *only* inside a long Settings modal. A user in Manual mode who never opens the AI buttons sees zero AI and no explanation.
- ActionPanel accept/dismiss is **hover-only** (`ActionPanel.tsx:333`, `opacity-0 group-hover:opacity-100`) — the primary way to accept an AI proposal is invisible until you mouse over the row.

---

## 2. The five principles to unify around

Codify these as the AI-surface contract (extends the `conventions.md` "AI feature guidelines"). Every existing and future AI surface conforms.

1. **One execution model: background + non-blocking, always.** No AI action ever blocks the UI on an `await`. Per-note actions fade their result in; multi-note actions run as a tracked background task and announce completion with a toast (and, where a decision is needed, a **Review**). The blocking sweeps in §1.1 are the only violations — they get converted, not redesigned.
2. **Every action gives proportional feedback.** Silent application still earns a quiet, dismissible "done" signal (toast or the activity log, §6). Nothing the AI does is *invisible*. Feedback strength scales with stakes: metadata = quiet toast; rewrite/move = preview or Review.
3. **One canonical home per capability, with the palette as its keyboard mirror.** Each capability has exactly one *primary* surface chosen by scope (per-note → editor; library-wide → sidebar, shown contextually when relevant). The command palette mirrors it for keyboard users. Redundant third entry points (a modal's own re-run is fine; a *duplicate launcher* is not) are removed. Same launch, same result surfacing, everywhere.
4. **AI-derived content is always marked and always reversible.** Keep the sage `✨` language (already consistent). Extend `source='ai'` provenance to titles (AI-13) so an AI title is visually distinct until the user edits it. Accept/dismiss affordances are *always visible*, never hover-gated.
5. **The AI is legible.** A running log of what AI did, where the user already looks (the queue popover). Plus a one-line, in-context explanation of *why there's no AI right now* when Manual mode or "backend: none" is the reason.

---

## 3. Direction A — the consistency pass

The lowest-risk, highest-leverage work. Mostly aligns existing behavior to the patterns already in `store.ts`.

### 3.1 Convert the three blocking sweeps to background tasks

`aiTitleUntitled`, `aiSummarizeMissing`, `aiRetagAll` move to the **same store-driven background pattern** as `startAutoArrange` / `startFindSimilar`:

- A `startBulk(kind)` store action kicks off the sweep without `await`ing it in the handler; the palette/sidebar return immediately.
- Progress shows in the **existing queue footer** ("Titling 4 of 12…") — these already produce per-note work the worker surfaces; the bulk launcher just needs to enqueue and report, not block.
- A completion toast ("Titled 12 notes") replaces the post-`await` count toast. No Review needed — titles/summaries/tags are additive reversible metadata (consent ladder allows silent), so the toast is *feedback*, not a gate.

Outcome: the bulk menu becomes internally consistent — every row is non-blocking and reports the same way.

### 3.2 Give "Organize" feedback, and put it on the right code path

- Point the manual Organize button at the **same `organize_note`** the queue uses (retire the `ai_process_note` split path, or make it call `organize_note` internally) so manual and automatic agree. Fixes §1.2's correctness seam.
- On completion, a quiet toast summarizing what changed: *"Added 3 tags · suggested folder: Recipes"* (folder still only a suggestion banner, never auto-moved — consent ladder). If nothing changed, *"No new suggestions."* Never silent again.
- Rename the button **"Organize"** is fine, but the toast is what makes it legible.

### 3.3 Always-visible accept/dismiss

Drop the `opacity-0 group-hover` gate on ActionPanel proposed-item controls (`ActionPanel.tsx:333`). Proposed AI items show their Accept (✓) / Dismiss (✗) at rest, lower-emphasis but present. (Pairs with QOL-2/keyboard-focus work already shipped.)

### 3.4 Resolve the naming collision

| Today | Becomes | Why |
|---|---|---|
| "Tidy board" (Board re-cluster) | **"Re-tidy"** / **"Regroup"** | it regroups; no merge, no stakes |
| "Tidy up similar notes" (merge dupes) | **"Merge duplicates"** | names the actual, higher-stakes action |

Pick one vocabulary and apply it in `Board.tsx`, `Sidebar.tsx`, the palette, and the modals.

---

## 4. Direction B — inline editor AI

Today AI in the editor lives *only* in the header cluster. The `/` slash menu (`editor/slash.ts`) and the selection bubble (`Editor.tsx` SelectionMenu) — the two places note apps universally expose inline AI — have **none**. Adding it is the biggest discoverability win, and it fits the existing surfaces with no new chrome.

### 4.1 Selection bubble → AI actions on the highlighted text

The bubble already appears on selection. Add a small sage-marked **AI** group (after the formatting buttons), each action operating on the selection and following the consent ladder:

| Action | Capability | Consent | Reuses |
|---|---|---|---|
| **Summarize** | one-line/bullets of the selection | inserts below as a quote, or shows keep/discard | `summarize` machinery |
| **Bulletify** | restructure selection to bullets | **keep/discard preview** (existing `RewritePreview`), snapshots on apply | `ai_bulletify_preview` / `apply_note_rewrite` |
| **Make action item** | the selection becomes a scheduled action | explicit (already the right-click action `Editor.tsx:325`) | `createActionItem` |
| **Stick to wall** | selection → text sticky | explicit | `stick_text` (from the stickies redesign) |

This unifies the *right-click menu* and the *bubble* — today "Add as action item" is right-click only; surface the same set in both so there's one inline-AI vocabulary.

### 4.2 Slash menu → summon AI on the current block / note

`/` at block start currently inserts plain markdown blocks. Add an **AI** section (sage `✨`, after the block items), gated on `llmReady`:

- **`/summarize`** — insert a summary of the note (or selection if any).
- **`/bulletify`** — keep/discard preview of the note restructured.
- **`/actions`** — extract action items (same as the header button), opens the panel.

Slash AI items must obey the same consent rules as their header equivalents (preview for rewrites, panel for actions). This is purely a *second discoverable launcher in the writing surface* — it does not introduce a new result model (Principle 3: palette/slash mirror, never diverge).

### 4.3 Guard rails

- Inline AI is **on-demand only** — it never makes the editor feel like it's watching you type. No ghost-text autocomplete, no "AI is thinking" while you write (that breaks "ignorable").
- Hidden entirely when `llm_backend === 'none'`, with a one-liner pointing to Settings (Principle 5), so the menu doesn't dangle dead options.

---

## 5. Direction C — consolidate entry points

Apply Principle 3: one canonical primary surface per capability + palette mirror. The table is the contract; everything not in the "Primary" column that is a *duplicate launcher* is removed (a modal's own re-run/re-scan stays — it's iteration within the flow, not a duplicate launcher).

| Capability | Scope | **Primary (canonical)** | Palette mirror | Remove |
|---|---|---|---|---|
| Auto-bullet | per-note | editor header + `/bulletify` + bubble | — | — |
| Organize (tags+folder) | per-note | editor header | — | — |
| Extract actions | per-note | editor header + `/actions` | — | ActionPanel "Scan note" duplicate launcher → keep one entry; panel shows results, doesn't relaunch |
| Summarize note | per-note | Board card menu "Refresh summary" + editor (`/summarize`) | — | — |
| Auto-title untitled | library | sidebar (contextual, when `untitledCount>0`) | ✓ | — (both kept, now consistent per §3.1) |
| Summarize missing | library | sidebar (contextual) | ✓ | — |
| Retag all | library | sidebar Tags header (2-step confirm) | ✓ | — |
| Merge duplicates | library | sidebar (contextual ready-state) | ✓ | the third launcher inside the modal stays as re-scan only |
| Auto-arrange | library | sidebar (contextual ready-state) | ✓ | modal re-plan stays as iteration |
| Collection summary | collection | SummaryBar under search | — | — |

**Principle in one line:** per-note AI is summoned *from the note* (header / slash / bubble); library AI is summoned *from the sidebar*, shown only when it's relevant (the contextual ready-state buttons are already the right pattern — `Sidebar.tsx:623-694` — they just need consistent execution from §3.1); the palette mirrors the library ones for keyboard. No capability has two *different* result behaviors anymore.

The sidebar contextual buttons are good but recede (`[10px]` text links). Consolidation is also a chance to give the library-AI group a faint shared heading or a single `✨` affordance so "this is where library-wide AI lives" reads at a glance — without inventing a new panel.

---

## 6. Direction D — transparency (AI-5) and per-note retry

Make the silent pipeline legible. This is the trust layer that lets §1.5's invisibility be a feature instead of a worry.

### 6.1 An `ai_activity` log

A small append-only table, surfaced where the user already watches AI work — the **queue-footer popover**.

```sql
CREATE TABLE ai_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id    TEXT,                 -- nullable (collection/library actions)
  action     TEXT NOT NULL,        -- 'tag' | 'title' | 'folder' | 'summary' | 'actions' | 'bulletify' | 'merge' | 'arrange'
  detail     TEXT,                 -- e.g. '+3 tags: coffee, v60, ratios'
  source     TEXT NOT NULL,        -- 'auto' | 'manual'
  model      TEXT,                 -- backend/model id used
  created_at INTEGER NOT NULL
);
```

- Written by `organize_note` and every manual AI command, after the DB commit (events-after-commit convention).
- The queue popover gains a **"Recent AI activity"** list: *"2m ago · Tagged 'Pour-over timing' +3 tags"*, each row clicking through to the note. This is also the natural home for future cloud/MCP entries (AI-8/9), so building it now pays forward.
- Respects the trash invariant on read (join `deleted_at IS NULL`).

### 6.2 Per-note summary retry (the missing "retry" affordance)

`improvements.md` Round-2 noted summaries are regenerable everywhere *except* per-note outside the editor. Add **Refresh / Retry** to the per-note summary wherever it shows (Board card menu already has it; mirror in the editor and the sidebar hover preview) so an off summary is one click from regenerating — "edit/retry/undo without restarting the flow."

### 6.3 Explain the absence of AI

When `automation_mode === 'manual'` or `llm_backend === 'none'`, the queue footer says so in one line with a link to Settings (*"Manual mode — AI runs only when you ask. Switch to Full Auto →"*). Today the only explanation lives buried in the modal; this closes §1.5's "why is nothing happening" gap without nagging.

### 6.4 Mark AI-authored titles (AI-13)

Extend `source='ai'` to titles. An AI-generated title carries a subtle sage tint / `✨` until the user edits it (then it's theirs). Closes the one place (besides bulletify) where AI content is visually indistinguishable from typed content — completing the provenance language tags already have.

---

## 7. Data model & touchpoints

- **DB / migrations** (additive only, golden rule 3): `ai_activity` table; `notes.title_source` (or reuse a tag-style provenance) for AI-13.
- **Backend**:
  - Manual Organize → call `organize_note` (retire/redirect `ai_process_note`).
  - Bulk commands (`ai_title_untitled`, `ai_summarize_missing`, `ai_retag_all`) gain a non-blocking, sweep-style invocation that the worker drains and reports — mirror `reindex_all`'s sweep so the footer shows progress.
  - Every AI write logs an `ai_activity` row.
  - New: `list_ai_activity` (paged, trash-filtered).
- **Frontend**:
  - `store.ts`: `startBulk(kind)` watchers paralleling `startAutoArrange`/`startFindSimilar`; a `aiActivity` slice.
  - `Editor.tsx`: Organize completion toast; AI section in the selection bubble; AI title tint.
  - `editor/slash.ts`: AI section (gated on `llmReady`).
  - `ActionPanel.tsx`: always-visible accept/dismiss.
  - `Sidebar.tsx` QueueFooter: Recent AI activity list + Manual/none explainer line.
  - `Board.tsx` / `Sidebar.tsx` / palette: naming pass ("Re-tidy" / "Merge duplicates").
  - `types.ts` mirrors any new model types.
- **Docs to update on ship**: `USER_GUIDE.md` (inline AI, activity log), `docs/features.md`, `conventions.md` (the five principles as AI-surface contract), `ROADMAP.md` status, this doc's phase ticks.

---

## 8. Deliberate non-goals

- **No new AI capabilities.** This is a surface/consistency pass — zero new model features. (Cloud/MCP — AI-8/9/10/12 — stay in their own track; the `ai_activity` table is built to receive them later, that's all.)
- **No ghost-text / as-you-type AI.** Inline AI is summoned, never ambient in the editor — protects "ignorable."
- **No new top-level AI panel.** Consolidation reuses the editor, sidebar, palette, and queue popover; it does not add a fifth place to look.
- **No change to the consent ladder or the local-by-default rule.** Silent stays silent only where it already legitimately is (additive metadata); everything else keeps its gate.
- **No re-litigating the background engine.** Queue scheduling, debounce, diff-gate, `organize_note` are all good — untouched except the manual-path redirect in §3.2.

## 9. Phased plan

One commit per row; ship in order (each independently valuable, lowest-risk first).

| Phase | Direction | Scope | Size |
|---|---|---|---|
| 1 | A | Convert the 3 blocking sweeps to background tasks (§3.1); resolve the Tidy naming collision (§3.4) | S–M |
| 2 | A | Organize → `organize_note` + completion toast (§3.2); always-visible accept/dismiss (§3.3) | S |
| 3 | D | `ai_activity` table + log writes + "Recent AI activity" in the queue popover; Manual/none explainer line (§6.1, §6.3) | M |
| 4 | B | Selection-bubble AI group + unify with right-click (§4.1) | M |
| 5 | B | Slash-menu AI section (§4.2) | S–M |
| 6 | C | Entry-point consolidation pass per the §5 table; library-AI shared affordance | S–M |
| 7 | D | AI-13 (mark AI titles) + per-note summary retry everywhere (§6.2, §6.4) | S |

Phase 1–2 alone remove the worst seams (blocking sweeps, silent Organize, hidden controls, name collision) and are pure cleanup. 3 onward is additive surface. Bench any prompt/path change (`npm run bench`) before it ships, per convention.

**Sources / priors:** the app's own `docs/improvements.md` (AI-1…AI-13, Round-2 AI-UX research), `docs/conventions.md` (consent ladder, AI feature guidelines), `docs/board-stickies-redesign.md` (the "summonable, review-first, off-by-default" AI stance this extends), and the friction audit of the current `src/` and `src-tauri/src/` (file:line refs inline above).
