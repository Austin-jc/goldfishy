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

## Shortlist (Apple Silicon, 16 GB)

| Model | Ollama pull | Size (Q4) | Speed vs Qwen3-4B | Notes |
|---|---|---|---|---|
| **Qwen3-4B-Instruct-2507** *(current default)* | `qwen3:4b-instruct-2507-q4_K_M` | ~2.5 GB | 1× (baseline) | Top small model on benchmarks; non-thinking, so no reasoning-token overhead — slowness is just 4B compute |
| **Qwen2.5-3B-Instruct** *(top "faster" pick)* | `qwen2.5:3b` | ~1.9 GB | ~1.5× | Best balance: excellent JSON + solid rewrites |
| **Llama-3.2-3B-Instruct** | `llama3.2:3b` | ~2.0 GB | ~1.5× | Strong summarization; weaker JSON (now grammar-pinned anyway) |
| **Gemma 3 4B** | `gemma3:4b` | ~3.3 GB | ~0.9× | Good rewrites; slightly heavier, not really "faster" |
| **Phi-4-mini (3.8B)** | `phi4-mini` | ~2.5 GB | ~1× | Strong reasoning for size; good at structured tasks |
| **Qwen2.5-1.5B-Instruct** *(fastest sane)* | `qwen2.5:1.5b-instruct-q8_0` | ~1.6 GB | ~2–3× | Use **q8**, not q4 — sub-3B degrades badly at 4-bit. Bulletify/summary quality drops |

**Recommendation order for "faster than Qwen3-4B":** `qwen2.5:3b` first; drop to
`qwen2.5:1.5b-instruct-q8_0` only if background tagging latency still bugs you
and you rarely use bulletify/summarize.

## Speed levers that aren't a model swap

- **Keep the model resident.** Ollama unloads after 5 min idle, so debounced
  background tagging can pay a cold-load penalty that *feels* like a slow model.
  `launchctl setenv OLLAMA_KEEP_ALIVE 30m` (or `-1` to pin forever).
- **MLX backend.** Update Ollama to ≥ 0.19 — it switched to the MLX backend on
  Apple Silicon (Mar 2026) for a free tok/s bump on M-series.
- **q8 for sub-3B.** 4-bit hurts tiny models disproportionately; prefer q8 below 3B.

## Adding a candidate to the bench

In `bench/bench.config.json`, add an `openai-compat` entry, then run it:

```jsonc
{ "name": "ollama-qwen2.5-3b", "provider": "openai-compat",
  "baseUrl": "http://localhost:11434", "model": "qwen2.5:3b" }
```

```sh
ollama pull qwen2.5:3b
npm run bench -- --models ollama-qwen2.5-3b          # det scores + latency
npm run bench -- --models ollama-qwen2.5-3b --judge  # + Claude-judged quality
```

Compare `det score` (format/correctness) and `latency` p50/p95 across candidates;
add `--judge` for the subjective half (summary depth, merge fidelity).

---

*Last updated 2026-06-10. Sources: [Qwen3 Technical Report](https://arxiv.org/pdf/2505.09388),
[distil labs small-model benchmark](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/),
[apxml — Local LLMs on Apple Silicon](https://apxml.com/posts/best-local-llms-apple-silicon-mac),
[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).*
