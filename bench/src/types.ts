// Shared types for the AI feature benchmark harness.

export type FeatureName =
  | "title"
  | "tags"
  | "actions"
  | "bulletify"
  | "merge"
  | "summary";

export const ALL_FEATURES: FeatureName[] = [
  "title",
  "tags",
  "actions",
  "bulletify",
  "merge",
  "summary",
];

/** A fully-built chat request, provider-agnostic. */
export interface BuiltRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Bare JSON schema for constrained decoding (no provider wrapper). */
  schema?: Record<string, unknown>;
  schemaName?: string;
}

export interface ChatResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelConfig {
  /** Display name used in reports and --models filters. */
  name: string;
  provider: "openai-compat" | "anthropic";
  /** Model id sent to the provider. */
  model: string;
  /** openai-compat only: server base URL, e.g. http://localhost:11434 */
  baseUrl?: string;
  /** Env var holding the bearer token / API key (optional for local servers). */
  apiKeyEnv?: string;
  /**
   * Raise each feature's max_tokens to at least this value. Needed for models
   * whose thinking tokens count against max_tokens (e.g. claude-fable-5,
   * where thinking is always on) — the app's tiny caps like 32 would starve them.
   */
  maxTokensFloor?: number;
  /** USD per million tokens; overrides the built-in Claude pricing table. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
}

export interface BenchConfig {
  /** Pinned "today" (YYYY-MM-DD) so relative-date fixtures grade deterministically. */
  today: string;
  runs: number;
  judge?: { model: string };
  models: ModelConfig[];
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface ScoreResult {
  /** Output was parseable the same way the app parses it. */
  valid: boolean;
  checks: CheckResult[];
  /** 0..1 — fraction of passed checks; 0 when invalid. */
  score: number;
  /** What the app would have stored after its own normalization. */
  parsed?: unknown;
}

export interface RunRecord {
  model: string;
  feature: FeatureName;
  fixture: string;
  run: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  raw?: string;
  score?: ScoreResult;
  judge?: { score: number; rationale: string };
}

// ---- fixtures ----

export interface TitleFixture {
  id: string;
  content: string;
  /** Title must mention at least one of these (case-insensitive). */
  mustMentionAny: string[];
}

export interface TagsFixture {
  id: string;
  title: string;
  content: string;
  folders: string[];
  existingTags: string[];
  maxTags: number;
  suggestFolders: boolean;
  /** At least one app-normalized tag must be in this set. */
  acceptableTags: string[];
  /** Canonical folder name the note should route to, or null. */
  expectedFolder: string | null;
}

export interface ActionsFixture {
  id: string;
  title: string;
  content: string;
  /** Existing category vocabulary (mirrors the app's DISTINCT category query). */
  categories: string[];
  expectedCount: [number, number];
  /** Substrings expected among extracted item texts (case-insensitive). */
  mustInclude: string[];
  /** Substrings that must NOT appear (completed work, plain facts). */
  mustExclude: string[];
  /** YYYY-MM-DD dates that must appear among resolved dues. */
  expectedDues: string[];
}

export interface BulletifyFixture {
  id: string;
  content: string;
  /** Literal substrings (links, image refs, facts) that must survive. */
  mustKeep: string[];
}

export interface NoteInput {
  title: string;
  content: string;
}

export interface MergeFixture {
  id: string;
  notes: NoteInput[];
  mustKeep: string[];
}

export interface SummaryFixture {
  id: string;
  notes: NoteInput[];
  /** At least 2 of these themes must be mentioned. */
  mustMentionAny: string[];
}

export interface Fixtures {
  title: TitleFixture[];
  tags: TagsFixture[];
  actions: ActionsFixture[];
  bulletify: BulletifyFixture[];
  merge: MergeFixture[];
  summary: SummaryFixture[];
}
