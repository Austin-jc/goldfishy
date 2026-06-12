export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Absolute timestamp for tooltips and metadata lines: "Jun 11, 2026, 12:45 AM". */
export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Display title for a note: its real title, else the first words of its text
 * as a stand-in while the AI is still titling it, else "Untitled".
 */
export function noteDisplayTitle(note: { title: string; content: string }): string {
  if (note.title.trim()) return note.title;
  const text = stripMarkdown(note.content);
  if (!text) return "Untitled";
  const head = text.split(" ").slice(0, 6).join(" ").slice(0, 40);
  return head.length < text.length ? head + "…" : head;
}

// ------------------------------------------------------------- todo lists

export interface TodoItem {
  /** Index into content.split("\n"). */
  line: number;
  checked: boolean;
  text: string;
}

const TODO_RE = /^\s*[-*+]\s+\[( |x|X)\]\s?(.*)$/;

/** Markdown task-list lines (`- [ ] …` / `- [x] …`) in a note's content. */
export function parseTodos(content: string): TodoItem[] {
  const out: TodoItem[] = [];
  content.split("\n").forEach((l, i) => {
    const m = TODO_RE.exec(l);
    if (m) out.push({ line: i, checked: m[1] !== " ", text: m[2] });
  });
  return out;
}

/** Flip the checkbox on one content line (no-op if the line isn't a task). */
export function toggleTodoAtLine(content: string, line: number): string {
  const lines = content.split("\n");
  const l = lines[line];
  if (l === undefined || !TODO_RE.test(l)) return content;
  lines[line] = /\[\s\]/.test(l) ? l.replace(/\[\s\]/, "[x]") : l.replace(/\[[xX]\]/, "[ ]");
  return lines.join("\n");
}

/** Append a new unchecked task line to the note's content. */
export function appendTodo(content: string, text: string): string {
  const item = `- [ ] ${text.trim()}`;
  const base = content.replace(/\s+$/, "");
  return base ? `${base}\n${item}` : item;
}

/**
 * AI summaries are markdown (bullets/checkboxes per the style setting); small
 * surfaces (cards, hover previews) want readable plain lines, not raw syntax.
 */
export function plainSummary(s: string): string {
  return s
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*[-*+]\s+\[( |x|X)\]\s?/, (_, c: string) => (c === " " ? "☐ " : "☑ "))
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/[*_`~]+/g, "")
        .trimEnd(),
    )
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/**
 * Preview text for small surfaces, honoring a "summary" | "excerpt" setting:
 * the note's AI summary when asked for and present, else a content excerpt.
 */
export function notePreview(
  note: { content: string; summary: string | null },
  mode: "summary" | "excerpt",
  max = 220,
): { text: string; isSummary: boolean } {
  if (mode === "summary" && note.summary?.trim()) {
    return { text: plainSummary(note.summary), isSummary: true };
  }
  return { text: stripMarkdown(note.content).slice(0, max), isSummary: false };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** FTS snippets arrive with literal <mark> tags; escape everything else. */
export function snippetHtml(snippet: string): string {
  return escapeHtml(snippet)
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p);
}

export const RECENCY_BUCKETS = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
] as const;

/** Which recency group header a timestamp belongs under (calendar days). */
export function recencyBucket(ms: number): (typeof RECENCY_BUCKETS)[number] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ms >= startOfToday) return "Today";
  if (ms >= startOfToday - day) return "Yesterday";
  if (ms >= startOfToday - 7 * day) return "Previous 7 days";
  if (ms >= startOfToday - 30 * day) return "Previous 30 days";
  return "Older";
}

// ----------------------------------------------------------------- line diff

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** A run of unchanged lines elided from a rendered diff. */
export interface DiffSkip {
  kind: "skip";
  count: number;
}

/**
 * Line-level LCS diff between two texts — sized for note snapshots, not
 * arbitrary files. Past ~4M line comparisons it degrades to a whole-text
 * replace rather than risking a UI stall.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  const idx = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[idx(i, j)] =
        a[i] === b[j]
          ? dp[idx(i + 1, j + 1)] + 1
          : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Elide long unchanged runs, keeping `context` lines around each change. */
export function collapseDiffContext(
  diff: DiffLine[],
  context = 2,
): (DiffLine | DiffSkip)[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | DiffSkip)[] = [];
  let skipped = 0;
  diff.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ kind: "skip", count: skipped });
        skipped = 0;
      }
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}
