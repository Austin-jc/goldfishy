// Prompt construction and reply parsing for the benchmark. Prompt text,
// schemas, token caps and truncation limits all come from prompts/prompts.json
// — the same file src-tauri/src/prompts.rs embeds — so the benchmark measures
// exactly what the app sends. Reply *parsing* below is still a 1:1 port of the
// normalization in ai.rs; keep those helpers in sync if ai.rs parsing changes.

import { readFileSync } from "node:fs";
import type { BuiltRequest, NoteInput } from "./types.ts";

interface PromptTask {
  system: string;
  user: string;
  max_tokens: number;
  limits?: Record<string, number>;
  schema?: Record<string, unknown>;
  schema_name?: string;
  /** Conditional fragments (tag_route) and corpus row templates (merge/summary). */
  [extra: string]: unknown;
}

const PROMPTS = JSON.parse(
  readFileSync(new URL("../../prompts/prompts.json", import.meta.url), "utf8"),
) as { version: number } & Record<string, PromptTask>;

/** Stamped into bench results so scores stay comparable across prompt edits. */
export const PROMPT_VERSION: number = PROMPTS.version;

function task(name: string): PromptTask {
  const t = PROMPTS[name];
  if (!t || typeof t !== "object") throw new Error(`prompts.json: missing task '${name}'`);
  return t;
}

function text(taskName: string, field: string): string {
  const v = task(taskName)[field];
  if (typeof v !== "string") {
    throw new Error(`prompts.json: ${taskName}.${field} must be a string`);
  }
  return v;
}

function limit(taskName: string, name: string): number {
  const v = task(taskName).limits?.[name];
  if (typeof v !== "number") {
    throw new Error(`prompts.json: ${taskName}.limits.${name} must be a number`);
  }
  return v;
}

/**
 * Replace `{key}` placeholders in one pass (substituted values are never
 * re-scanned). Unknown `{...}` sequences — like the literal JSON examples in
 * the prompts — pass through untouched. Mirrors prompts.rs::fill.
 */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m,
  );
}

// ---- helpers: 1:1 ports of the parsing/normalization in ai.rs ----

export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max).join("") + "…";
}

export function stripFences(s: string): string {
  const t = s.trim();
  if (!t.startsWith("```")) return t;
  const lines = t.split("\n");
  if (lines.length > 0) lines.shift();
  const last = lines[lines.length - 1];
  if (last !== undefined && last.trimStart().startsWith("```")) lines.pop();
  return lines.join("\n").trim();
}

export function extractJson(s: string): Record<string, unknown> | null {
  const cleaned = stripFences(s);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function normalizeTag(t: string): string {
  const joined = t.trim().toLowerCase().split(/\s+/).filter(Boolean).join("-");
  return Array.from(joined).slice(0, 40).join("");
}

export const TAG_STOPWORDS = [
  "done", "todo", "wip", "note", "notes", "text", "misc", "stuff", "idea",
  "ideas", "random", "general",
];

export function normalizeActionText(s: string): string {
  return s
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Port of ai.rs parse_due: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"; "null"/"" → null. */
export function parseDue(s: string): { date: string; time: string } | null {
  const t = s.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(t);
  if (m) {
    if (!isValidDate(m[1], m[2], m[3]) || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    if (!isValidDate(m[1], m[2], m[3])) return null;
    return { date: t, time: "09:00" }; // date-only defaults to 09:00, like the app
  }
  return null;
}

function isValidDate(y: string, mo: string, d: string): boolean {
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** chrono's "%A" — full English weekday name for a YYYY-MM-DD date. */
export function weekdayName(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
}

// ---- auto-title ----

export function buildTitle(content: string): BuiltRequest {
  return {
    system: text("title", "system"),
    user: fill(text("title", "user"), {
      content: truncateChars(content, limit("title", "content")),
    }),
    maxTokens: task("title").max_tokens,
  };
}

/** The app's title cleanup: first non-empty line, strip quotes/hashes/punctuation, cap 80 chars. */
export function parseTitleReply(reply: string): string {
  const firstLine =
    stripFences(reply)
      .split("\n")
      .find((l) => l.trim() !== "") ?? "";
  let t = firstLine.trim();
  t = t.replace(/^["“”'`#]+/, "").replace(/["“”'`#]+$/, "");
  t = t.replace(/[.!]+$/, "").trim();
  return Array.from(t).slice(0, 80).join("");
}

// ---- auto-tag & folder routing ----

export interface TagRouteInput {
  title: string;
  content: string;
  folders: string[];
  existingTags: string[];
  maxTags: number;
  suggestFolders: boolean;
}

export function buildTagRoute(opts: TagRouteInput): BuiltRequest {
  const tagInstructions =
    opts.maxTags === 0
      ? text("tag_route", "tag_instructions_off")
      : fill(text("tag_route", "tag_instructions"), {
          max_tags: String(opts.maxTags),
          tags_json: JSON.stringify(opts.existingTags),
        });
  const folderInstructions = opts.suggestFolders
    ? fill(text("tag_route", "folder_instructions"), {
        folders_json: JSON.stringify(opts.folders),
      })
    : text("tag_route", "folder_instructions_off");
  return {
    system: text("tag_route", "system"),
    user: fill(text("tag_route", "user"), {
      tag_instructions: tagInstructions,
      folder_instructions: folderInstructions,
      title: truncateChars(opts.title, limit("tag_route", "title")),
      content: truncateChars(opts.content, limit("tag_route", "content")),
    }),
    maxTokens: task("tag_route").max_tokens,
    schemaName: task("tag_route").schema_name,
    schema: task("tag_route").schema,
  };
}

// ---- action extraction ----

export interface ActionsInput {
  title: string;
  content: string;
  categories: string[];
  /** YYYY-MM-DD; pinned in the benchmark so date resolution grades deterministically. */
  today: string;
}

export function buildActions(opts: ActionsInput): BuiltRequest {
  return {
    system: text("actions", "system"),
    user: fill(text("actions", "user"), {
      today: `${opts.today} (${weekdayName(opts.today)})`,
      cats_json: JSON.stringify(opts.categories),
      title: truncateChars(opts.title, limit("actions", "title")),
      content: truncateChars(opts.content, limit("actions", "content")),
    }),
    maxTokens: task("actions").max_tokens,
    schemaName: task("actions").schema_name,
    schema: task("actions").schema,
  };
}

// ---- bulletify ----

export function buildBulletify(content: string): BuiltRequest {
  return {
    system: text("bulletify", "system"),
    user: fill(text("bulletify", "user"), {
      content: truncateChars(content, limit("bulletify", "content")),
    }),
    maxTokens: task("bulletify").max_tokens,
  };
}

// ---- merge ----

export function buildMerge(notes: NoteInput[]): BuiltRequest {
  let corpus = "";
  for (const n of notes) {
    corpus += fill(text("merge", "note_block"), {
      title: n.title.trim() === "" ? "(untitled)" : n.title.trim(),
      content: truncateChars(n.content, limit("merge", "note_content")),
    });
    if (corpus.length > limit("merge", "corpus")) break;
  }
  return {
    system: text("merge", "system"),
    user: fill(text("merge", "user"), { count: String(notes.length), corpus }),
    maxTokens: task("merge").max_tokens,
  };
}

// ---- collection summary ----

export function buildSummarize(notes: NoteInput[]): BuiltRequest {
  let corpus = "";
  for (const n of notes.slice(0, limit("summary", "max_notes"))) {
    corpus += fill(text("summary", "note_block"), {
      title: n.title === "" ? "(untitled)" : n.title,
      content: truncateChars(n.content, limit("summary", "note_content")),
    });
    if (corpus.length > limit("summary", "corpus")) break;
  }
  return {
    system: text("summary", "system"),
    user: fill(text("summary", "user"), { count: String(notes.length), corpus }),
    maxTokens: task("summary").max_tokens,
  };
}
