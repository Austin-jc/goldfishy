# Image-to-text (vision) + Clarify — design

Two AI features that share scaffolding: **transcribe a pasted image** (a screenshot
of a transcript, a code block, anything) into note text via a vision model, and
**Clarify** — clean up and complete the rough, fragmentary notes you type while
half-listening in a meeting. Both are explicit, review-first, user-summoned
actions. This doc locks the decisions; the build is phased in §6.

## Decisions locked (2026-06-17)

| Question | Decision |
|---|---|
| **Vision model** | A **separate, optional vision backend** (own url / model / key). When it's **not enabled, vision falls back to the primary model** (`llm_backend`). One capability split — text vs vision — *not* per-task model selection. |
| **Where transcribed text lands** | By default **inserted directly after the image it was extracted from**, with a per-action option to **delete the image after transcription**. |
| **Consent** | Both features are explicit, manual, review-first — sage keep/discard preview before anything is written (same pattern as Auto-bullet / Merge). Never automatic; never in the background pipeline. |
| **Clarify scope** | Complete obvious unfinished thoughts and fix grammar/shorthand; **never invent** facts, names, numbers, decisions or action items. Too-ambiguous fragments are left untouched. |

The model name the user first reached for — "Gemma 4" — doesn't exist yet; the
current multimodal Gemma is **Gemma 3** (`gemma3:4b`), already in our bench, and a
fine vision pick (its only black mark in `docs/ai-models.md` was *text* latency,
which is irrelevant for an occasional on-demand OCR call). Qwen2.5-VL is the other
strong local option.

---

## 1. What exists today (and the one missing piece)

**Image capture is already done.** Pasting or dropping an image saves it into
`images/<uuid>.ext` and embeds it as a `LocalImage` node — `handlePaste`
(`Editor.tsx:207`) → `api.saveImageBytes` → `save_image_bytes`
(`commands.rs:1907`); drag-drop at `Editor.tsx:293`; node at
`src/editor/extensions.ts:10`. The raw bytes are already in hand before they hit
disk. Nothing about transcription exists — a pasted screenshot is just stored and
shown.

**The LLM client is text-only.** Every AI feature funnels through
`ai::chat()` (`ai.rs:187`), which hardcodes string message content
(`ai.rs:216-221`):

```rust
"messages": [
  {"role": "system", "content": system},
  {"role": "user",   "content": user},
],
```

There is no concept of an image part, and **one global model** serves every
feature (`ai.rs:196`). So the entire net-new surface is: a multimodal request
path, a second (optional) backend for vision, and two prompts + two commands.

**Clarify is designed-in-intent but unbuilt.** `docs/motivations.md:27` already
names the exact scenario — *"a 'Clarify' action infers what the fragments
actually meant while keeping the original distinguishable"* — and it sits on the
backlog as `AI-8` (`docs/improvements.md:33`). Zero implementation today. The
closest shipped thing, Auto-bullet (`ai.rs:723`), only *reformats* and is told to
add nothing, so it can't finish a half-typed thought. But it gives Clarify its
whole skeleton: the `ai_bulletify_preview` → keep/discard `RewritePreview`
(`Editor.tsx:693`) → `apply_note_rewrite` flow, with `maybe_snapshot_note` on
apply (golden rule 4).

## 2. Design principles this inherits

From `docs/conventions.md` (AI feature guidelines) and `improvements.md`:

- **Propose, never silently rewrite.** Both features end in a sage keep/discard
  preview; rewrites snapshot unconditionally on apply (golden rule 4).
- **Local by default; cloud is explicit, labeled, off by default.** The
  background pipeline never touches these. If a *cloud* vision/text backend is
  configured, the action is labeled cloud-powered and discloses what it sends
  (AI-8).
- **Prompts live in one file.** New tasks go in `prompts/prompts.json` with a
  `version` bump (golden rule 5) — never inline strings in `ai.rs`.
- **AI must be ignorable.** No auto-transcribe on paste, no ambient rewriting;
  you summon both.

---

## 3. The design

### 3.1 A multimodal request path in `ai.rs`

Add a sibling to `chat()` that builds the OpenAI content-array form, which every
OpenAI-compatible vision server (Ollama, LM Studio, vLLM, hosted APIs) accepts:

```rust
pub async fn chat_vision(
    app: &AppHandle,
    system: &str,
    user_text: &str,
    images: &[VisionImage],   // { mime: "image/png", base64: "…" }
    max_tokens: u32,
) -> Result<String>
```

It emits the multimodal user turn:

```jsonc
{"role": "user", "content": [
  {"type": "text", "text": user_text},
  {"type": "image_url", "image_url": {"url": "data:image/png;base64,…"}}
]}
```

The backend-resolution block currently inlined in `chat()` (`ai.rs:196-214`) is
factored out into `resolve_backend(settings, Capability)` returning
`(base, model, api_key)`, so both `chat()` and `chat_vision()` share it. Same
`/v1/chat/completions` POST, bearer auth, 300s timeout, reply parsing.

### 3.2 The vision backend, and its fallback to primary

A **second, optional** backend dedicated to vision. New `AppSettings` fields
(mirroring the primary block at `models.rs:180-187`, all `#[serde(default)]`):

```rust
pub vision_backend: String,   // "none" | "external" | "sidecar"  (default "none")
pub vision_url: String,
pub vision_model: String,
pub vision_api_key: String,
```

`resolve_backend(settings, Capability::Vision)`:

1. `vision_backend == "external"` → use `vision_url` / `vision_model` / `vision_api_key`.
2. `vision_backend == "sidecar"` → vision sidecar (needs an `mmproj` projector — **deferred to Phase 3**, §3.6).
3. **`"none"` (default) → fall back to the primary resolution** (`llm_backend` + `external_*` / sidecar).

This is exactly the locked rule: *use the primary model when the vision model
isn't enabled.* The caveat is honest and surfaced, not hidden — if the
fallback primary is a text-only or local-sidecar model, the server rejects the
image and we return an **actionable** error rather than a stack trace:

> *"This model can't read images. Set a vision model in Settings → AI Engine →
> Vision, or point your server at a vision-capable model (e.g. Gemma 3)."*

(We can't reliably probe capability ahead of time across arbitrary
OpenAI-compatible servers, so a clear failure is the contract.)

**Settings UI:** a "Vision model (optional)" subsection added to the AI Engine
panel (`SettingsModal.tsx:180-344`), visually secondary, with a one-line helper:
*"Used only for reading images. Leave off to use your main model."* Plus the
existing "Test connection" affordance, pointed at the vision backend.

### 3.3 Paste → transcribe (the image flow)

Transcription is an **explicit action on an existing image node**, never
automatic on paste (paste keeps today's behavior: store + embed). Trigger
surfaces:

- A small **`✨ Transcribe`** control on the `LocalImage` node (node-view button,
  shown on hover/selection), and
- Image right-click → **"Transcribe to text"**, and a command-palette row.

On trigger:

1. Resolve the image's stored bytes from its `images/…` rel path, base64-encode
   (on the blocking pool — screenshots are multi-MB, per the main-thread rule),
   call `chat_vision` with the `image_to_text` prompt (§4).
2. The returned markdown is shown as a **sage keep/discard preview inserted
   directly after the image node** (locked default). Keep commits it; discard
   drops it. Reuses the `RewritePreview` visual language — but *additive* (it
   inserts after the image, it does not overwrite the user's surrounding text).
3. The preview carries a **"Delete image after transcription"** toggle (locked
   option). On Keep with it checked, the image node is removed (the `images/…`
   file is left for the normal orphan cleanup / export logic). Default:
   **off** — keep the image.

Because transcription only *adds* content (never overwrites user text), it sits
on the light rung of the consent ladder; the preview is for quality control and
cloud disclosure, not for protecting existing text. No snapshot needed for the
additive insert (snapshots are for overwrites — golden rule 4 still governs
Clarify in §3.4).

Why insert-after-image rather than "new note": the user's refined choice. It
keeps the screenshot and its transcription together in context (you're often
pasting a snippet *into* an ongoing note), and "new note from an image" can come
later via the capture window (§5, deferred) without redesigning this.

### 3.4 Clarify (the meeting-note flow)

A new editor-header button **`Clarify`** alongside Auto-bullet / Organize /
Extract actions (`Editor.tsx:446-489`), shown when `llmReady`. It is a
straight text-in / text-out rewrite on the **primary** model (no vision, no
separate backend):

1. `ai_clarify_preview(note_id)` runs the `clarify` prompt (§4) over the note
   body.
2. Result returns as the **same sage keep/discard diff preview** used by
   bulletify — which *is* how "keep the original distinguishable" is honored:
   the History-style line diff shows exactly what Clarify changed before you
   accept, and Keep snapshots the pre-Clarify text via `maybe_snapshot_note`
   (golden rule 4) so the original is one restore away. We deliberately do **not**
   litter the note with inline strikethrough originals — the diff preview +
   snapshot is the house pattern (`NOTE-4`, AI-1) and keeps the note clean.
3. Apply goes through the existing `apply_note_rewrite` path.

The prompt's contract is the whole feature: complete obvious unfinished thoughts,
fix shorthand/grammar, but **invent nothing** — no facts, names, numbers,
decisions, or action items that the fragments don't support; leave genuinely
ambiguous fragments as-is. (Extracting action items stays the separate, existing
`extract_actions` step — Clarify cleans prose, it doesn't schedule.)

### 3.5 Cloud disclosure (AI-8)

When either action resolves to a **cloud** backend (vision or primary):

- The button reads cloud-powered (small label / tint), and on first use shows a
  one-time "this sends the image / note text to `<host>`" confirmation.
- It logs to the future `ai_activity` table (AI-5) when that lands — the natural
  home for per-action cloud entries.
- The background worker can still **never** route to cloud (golden rule it
  already enforces; both these features are foreground-only anyway).

### 3.6 Local-sidecar vision (deferred)

llama.cpp `llama-server` *can* do vision, but only when launched with an `mmproj`
projector file alongside the GGUF; `ensure_sidecar` (`ai.rs:97`) doesn't wire
that up. So **Phase 1 ships vision via the external backend only** (Ollama /
LM Studio / hosted). Sidecar vision is Phase 3: add a `vision_mmproj_path`
setting and an mmproj-aware spawn. Until then, `vision_backend == "sidecar"` is
not offered in the UI.

---

## 4. Prompts (new entries in `prompts/prompts.json`, version bumped)

**`image_to_text`** — system: *"You transcribe the contents of an image into
clean markdown for a note-taking app. Reply with ONLY the markdown — no
preamble, no description of the image."* user: *"Transcribe everything legible in
this image into markdown. If it is code, use a fenced code block with the correct
language. If it is a conversation or transcript, preserve speakers and turns. If
it is a table, use a markdown table. Reproduce the content faithfully; do not
summarize, explain, or add anything that isn't in the image. If parts are
unreadable, mark them `[illegible]`."* (`max_tokens` generous, e.g. 2048.)

**`clarify`** — system: *"You clean up rough, fragmentary notes from a personal
note-taking app. Reply with ONLY the cleaned markdown — no preamble."* user:
*"These notes were typed quickly while the writer was listening to a meeting —
shorthand, half-words, dropped articles, unfinished sentences. Rewrite them as
clear, readable notes. Complete obvious unfinished thoughts and fix grammar and
shorthand. Do NOT invent facts, names, numbers, decisions, or action items that
the notes don't already imply. If a fragment is too ambiguous to complete
faithfully, leave it as it is. Preserve every distinct piece of information, all
links and image references.\n\n{content}"* (`max_tokens` ~2048, `limits.content`
~12000, mirroring `bulletify`.)

Per golden rule 5, both get benched (`npm run bench`) before prompts settle;
`clarify` is a natural new bench feature (its no-hallucination contract is exactly
the kind of thing deterministic checks + a judge pass should grade — e.g. "no
proper noun appears that wasn't in the source").

## 5. Data model & touchpoints

- **Settings** (`models.rs` `AppSettings` + `Default` + `types.ts` +
  `SettingsModal.tsx`, per conventions): `vision_backend`, `vision_url`,
  `vision_model`, `vision_api_key`. (Phase 3: `vision_mmproj_path`.)
- **`ai.rs`**: `resolve_backend(settings, Capability)` extracted from `chat()`;
  new `chat_vision()`; `image_to_text()` and `clarify()` feature fns.
- **Commands** (`commands.rs`, all `async`): `ai_image_to_text(image_rel)` →
  markdown; `ai_clarify_preview(note_id)` → proposed text (reuses
  `apply_note_rewrite` for apply).
- **`api.ts`**: one typed wrapper each (`aiImageToText`, `aiClarifyPreview`).
- **Frontend**: `LocalImage` node-view `✨ Transcribe` button + image
  context-menu/palette entry; insert-after-image keep/discard with
  "delete image" toggle; `Clarify` header button reusing `RewritePreview`;
  Vision subsection in `SettingsModal`; cloud-disclosure labeling.
- **Prompts**: `image_to_text`, `clarify`; `version` bump; bench entries.

## 6. Deliberate non-goals

- **No auto-transcribe on paste**, no ambient rewriting — both are summoned.
- **No vision (or Clarify) in the background pipeline** — foreground, explicit,
  per-action only.
- **No general per-task model picker.** Exactly one capability split (text vs
  vision). The "different model per feature" road stays closed (it's
  bench/eval tooling, not app config).
- **Clarify never invents** and is not an expander/"make it longer." It cleans;
  it doesn't author.
- **No inline original-vs-clarified markup** in the note body — the diff preview
  + snapshot is the record of "what was original."
- **Phase 1 vision is external-backend only**; local-sidecar mmproj is Phase 3.

## 7. Phased plan

| Phase | Scope | Size |
|---|---|---|
| 1 | `resolve_backend` refactor + `chat_vision`; vision settings + UI subsection (external only); `image_to_text` prompt + `ai_image_to_text`; node `✨ Transcribe` → insert-after-image keep/discard + delete-image toggle; cloud disclosure | M |
| 2 | `clarify` prompt + `ai_clarify_preview`; `Clarify` header button reusing `RewritePreview` + `apply_note_rewrite`; bench `clarify` feature | S–M |
| 3 (later) | Local-sidecar vision via `mmproj`; "New note from image" via capture window; `ai_activity` logging (AI-5/AI-8) | M |

**Sources:** `docs/motivations.md` (Clarify intent) · `docs/improvements.md`
(AI-8 disclosure, AI-12 secondary model, NOTE-4 diff-preview) ·
`docs/ai-models.md` (Gemma 3 / OpenAI-compatible model swap) ·
`docs/conventions.md` (consent ladder, golden rules 4 & 5) ·
[Ollama OpenAI vision compatibility](https://docs.ollama.com/api/openai-compatibility) ·
[llama.cpp multimodal / mmproj](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)
