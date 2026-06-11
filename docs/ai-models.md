# Candidate models for the AI engine

A shortlist of local LLMs to try for NexusNote's AI features (auto-tag + folder
routing, bulletify, collection summaries). The app talks to any
OpenAI-compatible server (Ollama, llama.cpp `llama-server`, LM Studio, vLLM),
so swapping models is just changing the model name in **Settings → AI Engine** —
no recompile.

> **Don't guess — measure.** The [`bench/`](../bench/README.md) harness scores
> any candidate on the app's real prompts, schemas, token caps, and reply
> parsing. Add the model to `bench/bench.config.json` and run
> `npm run bench -- --models <name>`. A model that scores well there behaves the
> same way in the app.

## Why small models are safe now

`auto_tag_and_route` sends a strict `json_schema` via `response_format`
(`ai.rs`), so Ollama/llama.cpp **constrain decoding to valid JSON** — the usual
failure mode of small models (malformed JSON) is eliminated by grammar, not by
model size. `extract_json` remains as a fallback for servers that ignore
`response_format`. The only thing you trade going smaller is rewrite/summary
quality (bulletify + summarize), which are on-demand, not the hot background loop.

The app also sends `num_ctx: 8192` and launches the sidecar with `-c 8192`, so
long notes aren't truncated to the 4096 default regardless of model.

## Shortlist (Apple Silicon, 16 GB) — measured 2026-06-11

All six candidates were benchmarked with the full harness (27 cases × 3 runs ×
7 features = 486 sequential requests, prompts v2, deterministic scores only —
no LLM judge). Side-by-side comparison:
**[HTML report](bench-local-models-2026-06-11.html)**. det score = fraction of
the app's deterministic checks passed (0–1); p50 = median request latency on
this machine.

| Model | Ollama pull | Size | det score | p50 overall | Measured notes |
|---|---|---|---|---|---|
| **Qwen3-4B-Instruct-2507** *(default)* | `qwen3:4b-instruct-2507-q4_K_M` | ~2.5 GB | **0.96** | 7.8s | Best everywhere; perfect tags/organize/summary. Weak spots: weekday math, merge verbosity |
| **Qwen2.5-3B-Instruct** | `qwen2.5:3b` | ~1.9 GB | 0.91 | **5.5s** | Fastest overall; 3× faster action extraction. But: folder routing flakes to `null`, dropped URLs in bulletify, never titled the untitled note |
| **Qwen2.5-1.5B-Instruct (q8)** | `qwen2.5:1.5b-instruct-q8_0` | ~1.6 GB | 0.87 | 6.5s | Far better than expected — 0.93 on organize (the hot loop), fastest heavy rewrites (~11s). Real pick for constrained hardware |
| **Gemma 3 4B** | `gemma3:4b` | ~3.3 GB | 0.91 | 18.2s | Good quality (0.96 tags) but the *slowest* here — not "~0.9×". Long outputs on every feature |
| **Llama-3.2-3B-Instruct** | `llama3.2:3b` | ~2.0 GB | 0.87 | 9.5s | Routes everything to *Work* (0.76 tags); summaries perfect. Folder routing bias disqualifies it for organize |
| **Phi-4-mini (3.8B)** | `phi4-mini` | ~2.5 GB | 0.84 | 8.3s | Weakest overall: 0.69 actions, 0.79 organize. Best bulletify (0.96), but that's not worth the trade |

### Per-feature det score (p50)

| feature | qwen3-4b | qwen2.5-3b | qwen2.5-1.5b-q8 | gemma3-4b | llama3.2-3b | phi4-mini |
|---|---|---|---|---|---|---|
| title | 1.00 (2.7s) | 0.97 (1.3s) | 0.87 (1.1s) | 1.00 (2.4s) | 1.00 (1.1s) | 0.88 (1.6s) |
| tags | 1.00 (3.1s) | 0.84 (1.2s) | 0.91 (1.3s) | 0.96 (2.3s) | 0.76 (1.2s) | 0.95 (2.1s) |
| actions | 0.91 (22.8s) | 0.84 (7.0s) | 0.78 (7.3s) | 0.75 (20.3s) | 0.76 (11.4s) | 0.69 (16.5s) |
| organize | 1.00 (5.8s) | 0.94 (5.7s) | 0.93 (6.5s) | 0.96 (20.7s) | 0.90 (12.4s) | 0.79 (6.9s) |
| bulletify | 0.92 (23.7s) | 0.92 (13.7s) | 0.92 (11.1s) | 0.92 (29.5s) | 0.92 (15.5s) | 0.96 (24.1s) |
| merge | 0.88 (32.2s) | 0.88 (21.5s) | 0.85 (11.1s) | 0.88 (25.0s) | 0.83 (16.6s) | 0.81 (23.9s) |
| summary | 1.00 (18.6s) | 1.00 (12.2s) | 0.88 (10.4s) | 0.83 (15.7s) | 1.00 (12.4s) | 0.88 (20.6s) |

### What each test does

Every test sends the app's *exact* prompt (from `prompts/prompts.json`) and
parses the reply exactly the way `ai.rs` does; **valid** means the app could
have used the reply at all, and the det score is the fraction of the checks
below that passed. Dates grade against a pinned "today" of 2026-06-10
(a Wednesday).

- **title** (5 fixtures) — generate a 3–8 word title for one note: meeting
  notes, a recipe, a debugging log, a CI-flake postmortem, and a one-line
  reminder. Checks: single-line reply, 3–8 words, fits 80 chars, needs no
  cleanup (no quotes/fences/trailing punctuation to strip), and mentions the
  note's actual topic.
- **tags** (5 fixtures) — suggest up to 2 tags and route the note to one of
  five folders, given an existing tag vocabulary: recipe → *Cooking*, training
  log → *Health*, trip plan → *Travel*, sprint retro → *Work* (should reuse the
  existing `meetings` tag), and a quotes collection that fits **no** folder
  (must return `null` rather than force a route). Checks: respects the tag cap,
  no stopword/filler tags, tags are 1–2 lowercase words, at least one relevant
  tag, exact folder match (or null).
- **actions** (5 fixtures) — extract up to 6 action items as JSON with a
  category and a resolved due date. Fixtures: a messy day note mixing real
  tasks with completed work, a purely informational note with **zero** actions
  (must return an empty list), a renovation kickoff with a hard deadline, a
  week plan stressing relative dates ("tomorrow", "friday", "june 20") plus an
  already-handled item that must be skipped, and a 9-item move-out braindump
  that tests the 6-item cap. Checks: item count in the expected range,
  must-find / must-not-propose items, correctly resolved dates, every due hint
  parseable.
- **organize** (5 fixtures) — the worker's combined single call (title + tags +
  folder + actions in one reply), run on the same five tags fixtures. Same
  tag/folder checks, plus: proposes a title *only* for the untitled note
  (`null` for titled ones) and returns well-formed action items.
- **bulletify** (3 fixtures) — restructure a stream-of-consciousness note into
  markdown bullets: an offsite plan, SSG research, and an incident postmortem.
  Checks: actually uses bullets, no preamble, stays ≤1.5× the source length,
  and preserves specific links, image refs, code identifiers and numbers
  (e.g. `RefillWorker.run`, `09:14`, `38k`).
- **merge** (2 fixtures) — merge overlapping notes into one: two Tokyo-trip
  notes, and three job-search notes (one untitled). Checks: deduplicates
  (output shorter than the sources combined), no preamble, and keeps every
  load-bearing fact, link and name (URLs, "ghibli", "sofia", …).
- **summary** (2 fixtures) — write one 4–6 sentence paragraph synthesizing a
  collection: six kitchen-renovation notes, five conference-talk-prep notes.
  Checks: sentence count, single paragraph, no heading/preamble, and mentions
  at least two of the collection's key themes.

### What the run revealed

- **Keep `qwen3:4b` as the default.** The background hot path is `organize`
  (the worker's single call), and qwen3-4b is *not* slow there (5.8s p50, tied
  with qwen2.5-3b) while scoring a perfect 1.00. The "qwen3 is slow" feeling
  comes from interactive **action extraction (22.8s p50)** — if that bites,
  `qwen2.5:3b` cuts it to 7.0s at a real quality cost (routing flakes, dropped
  links in bulletify).
- **`qwen2.5:1.5b-instruct-q8_0` is the surprise.** 0.87 overall, 0.93 on
  organize, and the fastest model on every long-output feature. The doc's old
  "bulletify/summary quality drops" warning didn't show up in deterministic
  checks (an LLM-judge pass may still separate prose quality).
- **Drop gemma3, llama3.2, and phi4-mini from the shortlist.** Each is strictly
  dominated: gemma3 matches qwen2.5-3b's quality at 3.3× its latency;
  llama3.2 mis-routes folders consistently; phi4-mini is weakest on exactly the
  structured tasks that run unattended.
- **Weekday resolution is weak across *all* models** — "friday" (from a
  Wednesday) resolved to the wrong date in most runs (often 2026-06-15, a
  Monday). If due-date precision matters, the actions prompt should spell out
  the weekday↔date mapping for the coming week rather than rely on model
  calendar math.
- **Merge expands instead of deduplicating** on the two strongest models — both
  qwen3-4b and qwen2.5-3b wrote merged notes *longer* than the sources combined
  in all 6 runs. A tighter "shorter than the inputs" instruction in the merge
  prompt would likely fix this for free.

Re-run after any prompt change: `npm run bench -- --models <names>`; the HTML
report lands next to the results JSON (`npm run bench:html` re-renders). Add
`--judge` with `ANTHROPIC_API_KEY` set for the subjective half (summary depth,
merge fidelity) that deterministic checks can't grade.

## Speed levers that aren't a model swap

- **Keep the model resident.** Ollama unloads after 5 min idle, so debounced
  background tagging can pay a cold-load penalty that *feels* like a slow model.
  `launchctl setenv OLLAMA_KEEP_ALIVE 30m` (or `-1` to pin forever).
- **MLX backend.** Update Ollama to ≥ 0.19 — it switched to the MLX backend on
  Apple Silicon (Mar 2026) for a free tok/s bump on M-series.
- **q8 for sub-3B.** 4-bit hurts tiny models disproportionately; prefer q8 below 3B.

## Adding a candidate to the bench

All six shortlist models are already in `bench/bench.config.json`. For a new
candidate, add an `openai-compat` entry, then run it:

```jsonc
{ "name": "ollama-mistral-7b", "provider": "openai-compat",
  "baseUrl": "http://localhost:11434", "model": "mistral:7b" }
```

```sh
ollama pull mistral:7b
npm run bench -- --models ollama-mistral-7b          # det scores + latency
npm run bench -- --models ollama-mistral-7b --judge  # + Claude-judged quality
```

Compare `det score` (format/correctness) and `latency` p50/p95 across candidates;
add `--judge` for the subjective half (summary depth, merge fidelity). Every run
also writes a side-by-side HTML report next to the results JSON.

---

*Last updated 2026-06-11 (added measured benchmark results). Sources: [Qwen3 Technical Report](https://arxiv.org/pdf/2505.09388),
[distil labs small-model benchmark](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/),
[apxml — Local LLMs on Apple Silicon](https://apxml.com/posts/best-local-llms-apple-silicon-mac),
[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).*
