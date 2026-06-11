# Coding conventions & architecture guidelines

The rules for working in this codebase. Most were earned the hard way — when one feels wrong, check `HANDOFF.md` for the war story before breaking it. Keep this doc and `HANDOFF.md` updated as new rules emerge.

## Golden rules (break nothing below)

1. **Main-thread rule (Rust).** Synchronous `#[tauri::command] fn`s run on the macOS main/UI thread. Any command that could wait on a contended lock, do file IO, or call the network/LLM/embedder **must** be `async fn` (runtime pool) or use `spawn_blocking`. Default new commands to `async fn`; sync is the exception for trivially cheap reads.
2. **Trash invariant.** Every query that reads notes filters `deleted_at IS NULL` — lists, FTS and semantic search, related/similar, tag counts, action-item joins, queue picks, status counts, exports. Forgetting it resurrects trashed notes.
3. **Migrations are additive only.** `migrate()` is an `execute_batch` of `IF NOT EXISTS` plus ignored `ALTER TABLE ADD COLUMN`s. Never rename/retype a column without introducing real versioned migrations first.
4. **Snapshot before AI rewrites.** Any code path that lets the LLM overwrite note content (bulletify, merge, future rewrite features) calls `maybe_snapshot_note` first, unconditionally.
5. **Prompts live in one file.** Every prompt, JSON schema, truncation limit, and max_tokens lives in `prompts/prompts.json`, embedded by `prompts.rs` (`include_str!`) and read by `bench/src/prompts.ts` — never inline prompt text in `ai.rs` or the bench. Any change there means bumping its `version` field (stamped into bench results so scores stay comparable). Reply *parsing* is still mirrored code: if you change parsing/normalization in `ai.rs`, mirror it in `bench/src/prompts.ts`.
6. **Never rename** the bundle identifier (`com.nexusnote.app`) or the db filename — either orphans user data.
7. **No hardcoded colors in components.** Every color comes from the theme variable ramps (see Theming below).

## Rust backend

- **Lock discipline**: hold the `db` mutex for the shortest possible scope (a `{ }` block around the query); never hold it across an `await`, file IO, or an embedder/LLM call. Status reads use atomics (`embedder_phase`), never the embedder mutex.
- **Modules by domain**: `commands.rs` (IPC surface only — real logic lives in `db.rs`/`ai.rs`/`embed.rs`), `queue.rs` (the worker), `models.rs` (serde types), `state.rs` (shared state). New domains get their own file, registered in `lib.rs`.
- **Commands**: `verb_noun` snake_case (`create_note`, `set_action_due`). Return `CmdResult<T>` with `estr`/`eanyhow` error mapping; user-visible failures should read like sentences.
- **Settings**: `AppSettings` is one `#[serde(default)]` JSON blob. Adding a field = struct + `Default` impl + `types.ts` + `SettingsModal`. Backend-owned settings live here; frontend-only state goes to localStorage.
- **Worker behavior**: long-running/periodic work belongs in the `queue.rs` tick with a cooldown atomic, debounce respect, and a `current_activity` label so the UI can show it. Failures set a 60s cooldown and emit `worker-error`; never tight-loop a failing pipeline.
- **Status flags**: any new per-note derived data follows the `CLEAN | PENDING | STALE` lifecycle with claim-then-write (`WHERE … AND status = 'PENDING'` guards against races with user edits).
- **LLM calls**: go through `ai.rs::chat()`; pass a strict `json_schema` via `response_format` where the output is structured, and write prompts so the fallback `extract_json` works — always ask for a JSON *object*, never a bare array. Prompt text, schemas, token caps and truncation limits come from `prompts/prompts.json` via the `prompts` module (golden rule 5); new AI features add a task entry there, never inline strings.
- **Events**: kebab-case `noun-verb(ish)` names (`note-updated`, `sweep-done`, `action-due`). Emit after state is committed to the DB, not before. Document new events in `docs/architecture.md`'s catalog and register the listener in `App.tsx`.

## TypeScript / React frontend

- **Types**: `types.ts` mirrors `models.rs` — change them together. Don't hand-roll variants of model types in components.
- **IPC**: every Tauri command gets exactly one typed wrapper in `api.ts`; components never call `invoke` directly.
- **State**: one zustand store (`store.ts`). Components subscribe with narrow selectors (`useStore(s => s.notes)`), not whole-store grabs. Cross-component state goes in the store; truly local UI state stays in the component.
- **Backend events**: all `listen()` calls live in the `App.tsx` mount effect and dispatch into the store.
- **localStorage**: frontend-only persistence, `nn.*` keys only, registered in the HANDOFF key list (`nn.theme`, `nn.zoom`, …).
- **Components**: PascalCase file per component under `components/`; editor-specific extensions under `editor/`.
- **Icons**: lucide-react (pinned v1.17) — check `node_modules/lucide-react/dist/esm/icons/` before using a name. SVG icons only, never emoji as UI icons (emoji are fine *inside user content*).
- **Popovers**: `fixed inset-0` click-catcher + absolute panel; use a `fixed` + anchor-rect variant when a scroll container could clip (see DueDatePicker).

## Theming

- Three CSS-variable ramps, semantic not literal: `stone-*` neutrals (**950 = app background, 100 = strongest text**, light themes invert lightness), `clay-*` the single interactive accent (600 = button bg at ≥4.5:1 with white text), `sage-*` reserved for AI-derived things. `--color-code-bg` one step past app bg.
- New theme = one `[data-theme="x"]` CSS block overriding the same variables (+ `color-scheme`) + one entry in `themes.ts`. Nothing else.
- Errors stay fixed dark-red/light-red (readable on every theme).
- No borders between regions — separation by tone shift + whitespace.

## AI feature guidelines

- **Consent ladder**: silent is OK only for additive, reversible metadata (tags, titles on untitled notes). Anything that moves, schedules, or rewrites needs an explicit Accept (folder suggestions, action items) or a review-first keep/discard preview (bulletify, merge) — and rewrites still snapshot unconditionally on apply (golden rule 4).
- **Distinguish AI output** from user input visually (sage ramp, ✨) and in data (`source='ai'`); never overwrite manual equivalents (manual tags, user-typed titles).
- **Local by default**: the automatic background pipeline only ever uses the local backend. Cloud/frontier models (when added) are explicit per-action calls, clearly labeled, off by default.
- **Idle-respecting**: background AI runs only after typing stops (debounces) and never blocks the UI with modals; results fade in.
- **Every automatic behavior gets a toggle** in Settings; explicit manual actions stay available whenever a backend is configured.
- **Benchmark before switching models or editing prompts** (`npm run bench`); quality regressions are cheaper to catch there than in the app.

## Workflow

- **Checks before calling something done**: `npm run build` (tsc + vite) for frontend, `cargo check` in `src-tauri/` for backend. `npm run tauri dev` to verify behavior live.
- **Docs upkeep**: which doc gets what —
  - `docs/architecture.md` — stable structure (update when the shape of the system changes)
  - `docs/features.md` + `USER_GUIDE.md` — when user-facing behavior changes
  - `docs/conventions.md` — when a new rule is established
  - `ROADMAP.md` — feature status; `HANDOFF.md` — working knowledge, invariants, gotchas
- **Dev profile**: deps build at `opt-level 2`, our crate at 1 (see Cargo.toml comment). Don't "fix" dev slowness by changing the release profile.
- **Commits**: imperative subject line describing the user-visible change (matches existing history).
