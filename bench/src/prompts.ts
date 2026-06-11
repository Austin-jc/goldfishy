// Ports of the prompt construction and reply parsing in src-tauri/src/ai.rs.
// Kept byte-identical to the app so the benchmark measures exactly what the
// app would send and store. If you change a prompt in ai.rs, change it here.

import type { BuiltRequest, NoteInput } from "./types.ts";

// ---- helpers (ai.rs:22-68) ----

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

// ---- auto-title (ai.rs:608-648) ----

export function buildTitle(content: string): BuiltRequest {
  return {
    system:
      "You title notes. Reply with ONLY the title text — plain words, no quotes, no markdown, no trailing punctuation.",
    user: `Write a concise, descriptive title (3-8 words) for this note:\n\n${truncateChars(content, 4000)}`,
    maxTokens: 32,
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

// ---- auto-tag & folder routing (ai.rs:238-312) ----

export interface TagRouteInput {
  title: string;
  content: string;
  folders: string[];
  existingTags: string[];
  maxTags: number;
  suggestFolders: boolean;
}

export function buildTagRoute(opts: TagRouteInput): BuiltRequest {
  const tagsJson = JSON.stringify(opts.existingTags);
  const foldersJson = JSON.stringify(opts.folders);
  const tagInstructions =
    opts.maxTags === 0
      ? "Return an empty tags list."
      : `Suggest at most ${opts.maxTags} short lowercase topical tags (1-2 words each) — fewer is better, and an empty list is fine if nothing fits strongly. Tags must name the note's topic or domain (e.g. "rust", "recipes", "travel"). Reuse a tag from this existing vocabulary whenever one fits: ${tagsJson}. Never use status or filler words (done, todo, wip, note, notes, text, misc, stuff, idea, random), bare verbs, or words that merely appear in the note without describing it.`;
  const folderInstructions = opts.suggestFolders
    ? `Also choose the single best destination folder for the note from this list: ${foldersJson}. Use null for the folder if none fits well or the list is empty.`
    : "Use null for the folder.";
  return {
    system:
      "You are the organization engine inside a note-taking app. Reply with ONLY valid JSON. No prose, no markdown fences.",
    user: `${tagInstructions}\n${folderInstructions}\n\nNOTE TITLE: ${truncateChars(opts.title, 200)}\nNOTE CONTENT:\n${truncateChars(opts.content, 6000)}\n\nReply with JSON exactly like: {"tags": ["tag1"], "folder": "folder name or null"}`,
    maxTokens: 250,
    schemaName: "note_meta",
    schema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        folder: { type: ["string", "null"] },
      },
      required: ["tags", "folder"],
      additionalProperties: false,
    },
  };
}

// ---- action extraction (ai.rs:410-470) ----

export interface ActionsInput {
  title: string;
  content: string;
  categories: string[];
  /** YYYY-MM-DD; pinned in the benchmark so date resolution grades deterministically. */
  today: string;
}

export function buildActions(opts: ActionsInput): BuiltRequest {
  const today = `${opts.today} (${weekdayName(opts.today)})`;
  const catsJson = JSON.stringify(opts.categories);
  return {
    system:
      "You extract action items from personal notes. Reply with ONLY valid JSON. No prose, no markdown fences.",
    user: `Today is ${today}. Extract up to 6 concrete action items (tasks, follow-ups, reminders) from the note below. Only include real actions the author still needs to do — not facts, ideas, or completed work. If there are none, return an empty list.\nFor each item give: "text" (short imperative phrase), "category" (one or two lowercase words; reuse one of ${catsJson} when it fits, else invent a sensible one like "work", "errands", "health", "follow-up"), and "due" — "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" if the note implies a date or deadline (resolve relative phrases like "tomorrow" or "next friday" using today's date), else null.\n\nNOTE TITLE: ${truncateChars(opts.title, 200)}\nNOTE CONTENT:\n${truncateChars(opts.content, 8000)}\n\nReply with JSON exactly like: {"items": [{"text": "...", "category": "...", "due": null}]}`,
    maxTokens: 600,
    schemaName: "action_items",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              category: { type: "string" },
              due: { type: ["string", "null"] },
            },
            required: ["text", "category", "due"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  };
}

// ---- bulletify (ai.rs:542-560) ----

export function buildBulletify(content: string): BuiltRequest {
  return {
    system:
      "You restructure messy notes into clean markdown. Reply with ONLY the restructured markdown — no preamble, no explanation.",
    user: `Rewrite the following stream-of-consciousness note as concise markdown bullet points. Group related points under short bold headings where it helps. Preserve every distinct piece of information, all links and image references.\n\n${truncateChars(content, 12000)}`,
    maxTokens: 2048,
  };
}

// ---- merge (ai.rs:579-598) ----

export function buildMerge(notes: NoteInput[]): BuiltRequest {
  let corpus = "";
  for (const n of notes) {
    corpus += `### ${n.title.trim() === "" ? "(untitled)" : n.title.trim()}\n${truncateChars(n.content, 6000)}\n\n`;
    if (corpus.length > 24_000) break;
  }
  return {
    system:
      "You merge overlapping personal notes into one well-organized markdown note. Reply with ONLY the merged markdown — no preamble.",
    user: `Merge these ${notes.length} overlapping notes into a single coherent markdown note. Preserve every distinct fact, link, image reference and task. Remove duplicated information. Organize with short headings where it helps.\n\n${corpus}`,
    maxTokens: 3072,
  };
}

// ---- collection summary (ai.rs:651-693) ----

export function buildSummarize(notes: NoteInput[]): BuiltRequest {
  let corpus = "";
  for (const n of notes.slice(0, 40)) {
    corpus += `## ${n.title === "" ? "(untitled)" : n.title}\n${truncateChars(n.content, 1200)}\n\n`;
    if (corpus.length > 16_000) break;
  }
  return {
    system:
      "You summarize collections of personal notes. Reply with ONLY the summary paragraph — no heading, no preamble.",
    user: `Write one concise paragraph (4-6 sentences) that synthesizes the key themes, facts, decisions and open items across this collection of ${notes.length} notes:\n\n${corpus}`,
    maxTokens: 500,
  };
}
