// Two ways to reach a model:
//  - openai-compat: the exact request the app's ai::chat() sends (ai.rs:167-235),
//    so local backends (Ollama, llama-server, LM Studio, vLLM) are measured on
//    the same wire format the app uses in production.
//  - anthropic: the official Anthropic SDK, for benchmarking Claude models the
//    app could adopt. Structured-output features map to output_config.format.

import Anthropic from "@anthropic-ai/sdk";
import type { BuiltRequest, ChatResult, ModelConfig } from "./types.ts";

/** Mirrors LLM_NUM_CTX in ai.rs. */
const LLM_NUM_CTX = 8192;

export async function chat(m: ModelConfig, req: BuiltRequest): Promise<ChatResult> {
  return m.provider === "anthropic" ? chatAnthropic(m, req) : chatOpenAICompat(m, req);
}

function effectiveMaxTokens(m: ModelConfig, req: BuiltRequest): number {
  return Math.max(req.maxTokens, m.maxTokensFloor ?? 0);
}

// ---- OpenAI-compatible (what the app speaks today) ----

async function chatOpenAICompat(m: ModelConfig, req: BuiltRequest): Promise<ChatResult> {
  const base = (m.baseUrl ?? "").replace(/\/+$/, "");
  if (base === "") {
    throw new Error(`model "${m.name}": baseUrl is required for provider openai-compat`);
  }
  const body: Record<string, unknown> = {
    model: m.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    temperature: 0.3,
    max_tokens: effectiveMaxTokens(m, req),
    // Ollama-specific context hint, ignored by other servers — same as the app.
    num_ctx: LLM_NUM_CTX,
  };
  if (req.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: req.schemaName ?? "output", strict: true, schema: req.schema },
    };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = m.apiKeyEnv ? process.env[m.apiKeyEnv] : undefined;
  if (key && key.trim() !== "") headers.authorization = `Bearer ${key.trim()}`;

  const resp = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000), // the app's 300s request timeout
  });
  const json = (await resp.json().catch(() => {
    throw new Error("LLM server returned a non-JSON response");
  })) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (!resp.ok) {
    throw new Error(`LLM server error ${resp.status}: ${JSON.stringify(json)}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response missing choices[0].message.content");
  }
  return {
    text: content.trim(),
    inputTokens: json.usage?.prompt_tokens,
    outputTokens: json.usage?.completion_tokens,
  };
}

// ---- Anthropic (candidate models the app could adopt) ----

let anthropicClient: Anthropic | null = null;
export function anthropic(): Anthropic {
  // Resolves credentials from ANTHROPIC_API_KEY or an `ant auth login` profile.
  anthropicClient ??= new Anthropic();
  return anthropicClient;
}

async function chatAnthropic(m: ModelConfig, req: BuiltRequest): Promise<ChatResult> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: m.model,
    max_tokens: effectiveMaxTokens(m, req),
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    // No temperature: Fable 5 / Opus 4.8 / 4.7 reject sampling params, and the
    // remaining models behave fine at their defaults. Thinking is left at each
    // model's default; for always-thinking models set maxTokensFloor in config.
  };
  if (req.schema) {
    params.output_config = { format: { type: "json_schema", schema: req.schema } };
  }
  const response = await anthropic().messages.create(params);
  if (response.stop_reason === "refusal") {
    throw new Error("model refused the request (stop_reason: refusal)");
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text: text.trim(),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ---- cost estimation ----

/** USD per million tokens (input, output). Claude prices as of 2026-06. */
const DEFAULT_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function estimateCostUsd(
  m: ModelConfig,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  const p = m.pricing ?? DEFAULT_PRICING[m.model];
  if (!p || inputTokens == null || outputTokens == null) return undefined;
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1e6;
}
