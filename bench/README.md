# AI feature benchmark harness

Benchmarks candidate LLMs on NexusNote's AI features — **title generation, auto-tagging + folder routing, action extraction, bulletify, note merging, and collection summaries** — using the app's *exact* prompts, token caps, JSON schemas, and reply parsing (ported 1:1 from `src-tauri/src/ai.rs` into `src/prompts.ts`). A model that scores well here will behave the same way inside the app.

## What it measures

| Metric | Meaning |
|---|---|
| **valid** | The reply was parseable the same way the app parses it (`extract_json`, title cleanup, etc.) |
| **det score** | 0–1, fraction of deterministic checks passed — format compliance, expected tags/folder, action recall, due-date resolution, link/fact preservation, sentence counts |
| **judge** | optional 1–5 quality grade from a Claude judge (`--judge`), for the subjective half: title quality, summary depth, merge fidelity |
| **latency** | wall-clock p50/p95 per request (sequential, like the app's worker queue) |
| **tokens / cost** | from the provider's usage block; cost auto-computed for Claude models, or via `pricing` in config |

## Setup

```sh
npm install                      # installs @anthropic-ai/sdk (the only bench dep)
export ANTHROPIC_API_KEY=sk-...  # only needed for anthropic models or --judge
ollama pull llama3.2             # or whatever local models you want to compare
```

Requires Node ≥ 22.6 (the scripts run as native TypeScript; no build step). This repo's Node 24 works out of the box.

## Run

```sh
npm run bench                                  # all models/features in bench.config.json
npm run bench -- --models ollama-llama3.2      # one model
npm run bench -- --features title,tags,actions # subset of features
npm run bench -- --runs 1                      # quick pass
npm run bench -- --judge                       # add Claude-judged quality scores
npm run bench -- --dry-run                     # print every prompt, send nothing
npm run bench:report                           # re-render the latest results file
```

Each run writes `bench/results/run-<timestamp>.json` (every raw reply, check, and timing) and a matching `.md` report with per-feature tables plus a list of every failed check.

## Configuration (`bench.config.json`)

```jsonc
{
  "today": "2026-06-10",   // pinned "today" so relative due dates grade deterministically
  "runs": 3,
  "judge": { "model": "claude-opus-4-8" },
  "models": [
    // What the app speaks today — any OpenAI-compatible server
    // (Ollama, llama-server sidecar, LM Studio, vLLM). Requests match
    // ai::chat() exactly: temperature 0.3, num_ctx 8192, response_format.
    { "name": "ollama-llama3.2", "provider": "openai-compat",
      "baseUrl": "http://localhost:11434", "model": "llama3.2",
      "apiKeyEnv": "MY_SERVER_KEY" },          // optional bearer token env var

    // Claude candidates via the official Anthropic SDK. Structured-output
    // features use output_config.format; no sampling params are sent.
    { "name": "claude-haiku-4-5", "provider": "anthropic", "model": "claude-haiku-4-5" }
  ]
}
```

Per-model options:

- `maxTokensFloor` — raise the app's per-feature `max_tokens` caps to at least this value. Needed for `claude-fable-5` (thinking is always on and counts against `max_tokens`, so the app's 32-token title cap would starve it — use e.g. `4096`).
- `pricing: { inputPerMTok, outputPerMTok }` — USD/MTok for cost columns on non-Claude hosted models. Claude pricing is built in.

To benchmark the **llama-server sidecar** path, start it manually and point an `openai-compat` entry at it:

```sh
llama-server -m model.gguf --port 8757 -c 8192
# config: { "baseUrl": "http://127.0.0.1:8757", "model": "default" }
```

## The judge

`--judge` grades every successful reply 1–5 against a per-feature rubric using structured outputs (default judge: `claude-opus-4-8` with adaptive thinking; override with `--judge-model`). Use a judge model that supports adaptive thinking (Opus 4.6+, Sonnet 4.6, Fable 5). Deterministic checks already cover formatting, so the judge focuses on substance: did the title capture the note, did the merge lose facts, is the summary accurate. Judging a full run of the default config costs roughly a few cents per candidate model.

## Adding fixtures

Edit `fixtures/fixtures.json`. Conventions:

- Dates inside `actions` fixtures assume `config.today` (2026-06-10, a Wednesday). "tomorrow" → `2026-06-11`. If you change `today`, update `expectedDues`.
- `mustKeep` / `mustInclude` entries are case-insensitive literal substrings — pick tokens a faithful output cannot avoid (URLs, names, numbers).
- An actions fixture with `expectedCount: [0, 0]` tests the "return an empty list" instruction — a strong discriminator between models.

## Keeping prompts in sync

`src/prompts.ts` is a manual port of `src-tauri/src/ai.rs` (builders *and* reply-parsing helpers). If you change a prompt, schema, truncation limit, or `max_tokens` in `ai.rs`, mirror it there — otherwise the benchmark measures prompts the app no longer sends.
