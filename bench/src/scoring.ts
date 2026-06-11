// Deterministic, objective scorers — one per feature. Each scorer parses the
// raw model reply exactly the way the app does (prompts.ts ports of ai.rs),
// then grades the parsed result against the fixture's expectations.
// score = fraction of passed checks; valid = the app could use the reply at all.

import {
  extractJson,
  normalizeTag,
  parseDue,
  parseTitleReply,
  stripFences,
  TAG_STOPWORDS,
  truncateChars,
} from "./prompts.ts";
import type {
  ActionsFixture,
  BulletifyFixture,
  CheckResult,
  MergeFixture,
  ScoreResult,
  SummaryFixture,
  TagsFixture,
  TitleFixture,
} from "./types.ts";

function ci(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function finish(valid: boolean, checks: CheckResult[], parsed?: unknown): ScoreResult {
  const score =
    valid && checks.length > 0 ? checks.filter((c) => c.pass).length / checks.length : 0;
  return { valid, checks, score, parsed };
}

// ---- title ----

export function scoreTitle(reply: string, f: TitleFixture): ScoreResult {
  const parsed = parseTitleReply(reply);
  const valid = parsed.length > 0;
  if (!valid) return finish(false, []);
  const cleaned = stripFences(reply);
  const nonEmptyLines = cleaned.split("\n").filter((l) => l.trim() !== "");
  const words = parsed.split(/\s+/).filter(Boolean);
  const checks: CheckResult[] = [
    { name: "3-8 words", pass: words.length >= 3 && words.length <= 8, detail: `${words.length} words` },
    {
      name: "fits 80 chars uncut",
      pass: Array.from((nonEmptyLines[0] ?? "").trim()).length <= 80,
    },
    { name: "single-line reply", pass: nonEmptyLines.length === 1 },
    {
      name: "no cleanup needed",
      pass: cleaned.trim() === parsed,
      detail: "reply needed no quote/fence/punctuation stripping",
    },
    {
      name: "mentions the topic",
      pass: f.mustMentionAny.some((k) => ci(parsed, k)),
      detail: `any of: ${f.mustMentionAny.join(", ")}`,
    },
  ];
  return finish(true, checks, parsed);
}

// ---- tags & folder routing ----

export function scoreTags(reply: string, f: TagsFixture): ScoreResult {
  const json = extractJson(reply);
  const valid = json !== null && Array.isArray(json.tags) && "folder" in json;
  if (!valid) return finish(false, []);
  const rawTags = (json.tags as unknown[]).filter((t): t is string => typeof t === "string");
  // The app's pipeline: normalize → drop stopwords/empties → clamp to maxTags.
  const appTags = rawTags
    .map(normalizeTag)
    .filter((t) => t !== "" && !TAG_STOPWORDS.includes(t))
    .slice(0, f.maxTags);
  const folderRaw = typeof json.folder === "string" ? json.folder.trim() : null;
  const resolvedFolder = folderRaw
    ? (f.folders.find((n) => n.toLowerCase() === folderRaw.toLowerCase()) ?? null)
    : null;

  const checks: CheckResult[] = [
    {
      name: `respects max ${f.maxTags} tags`,
      pass: rawTags.length <= f.maxTags,
      detail: `${rawTags.length} returned`,
    },
    {
      name: "no stopword/filler tags",
      pass: rawTags.map(normalizeTag).every((t) => !TAG_STOPWORDS.includes(t)),
      detail: rawTags.join(", "),
    },
    {
      name: "tags are 1-2 lowercase words",
      pass: rawTags.every(
        (t) => t === t.toLowerCase() && t.trim().split(/\s+/).filter(Boolean).length <= 2,
      ),
    },
    {
      name: "suggested a relevant tag",
      pass: appTags.some((t) => f.acceptableTags.includes(t)),
      detail: `got: ${appTags.join(", ") || "(none)"}`,
    },
    {
      name: "routed to expected folder",
      pass: (resolvedFolder ?? null) === f.expectedFolder,
      detail: `got: ${resolvedFolder ?? "null"}, want: ${f.expectedFolder ?? "null"}`,
    },
  ];
  return finish(true, checks, { tags: appTags, folder: resolvedFolder });
}

// ---- action extraction ----

interface ExtractedAction {
  text: string;
  category: string;
  rawDue: string | null;
  due: { date: string; time: string } | null;
}

export function scoreActions(reply: string, f: ActionsFixture): ScoreResult {
  const json = extractJson(reply);
  const valid = json !== null && Array.isArray(json.items);
  if (!valid) return finish(false, []);
  // Mirror the app's filter_map: drop empty texts, normalize categories, cap at 6.
  const items: ExtractedAction[] = (json.items as unknown[])
    .flatMap((v): ExtractedAction[] => {
      if (typeof v !== "object" || v === null) return [];
      const o = v as Record<string, unknown>;
      const text = typeof o.text === "string" ? o.text.trim() : "";
      if (text === "") return [];
      const category =
        (typeof o.category === "string" ? normalizeTag(o.category) : "") || "general";
      const rawDue = typeof o.due === "string" ? o.due : null;
      return [
        {
          text: truncateChars(text, 200),
          category,
          rawDue,
          due: rawDue ? parseDue(rawDue) : null,
        },
      ];
    })
    .slice(0, 6);

  const [lo, hi] = f.expectedCount;
  const checks: CheckResult[] = [
    {
      name: `item count in [${lo}, ${hi}]`,
      pass: items.length >= lo && items.length <= hi,
      detail: `${items.length} items`,
    },
  ];
  for (const kw of f.mustInclude) {
    checks.push({ name: `found action: ${kw}`, pass: items.some((i) => ci(i.text, kw)) });
  }
  for (const kw of f.mustExclude) {
    checks.push({
      name: `did not propose: ${kw}`,
      pass: !items.some((i) => ci(i.text, kw)),
    });
  }
  for (const d of f.expectedDues) {
    checks.push({
      name: `resolved due ${d}`,
      pass: items.some((i) => i.due?.date === d),
      detail: `dues: ${items.map((i) => i.due?.date ?? "null").join(", ") || "(none)"}`,
    });
  }
  const dueHints = items
    .map((i) => i.rawDue)
    .filter((d): d is string => d !== null && d.trim() !== "" && d.trim().toLowerCase() !== "null");
  checks.push({
    name: "all due hints parseable",
    pass: dueHints.every((d) => parseDue(d) !== null),
    detail: dueHints.join(", ") || "(no due hints)",
  });
  return finish(true, checks, items);
}

// ---- bulletify ----

export function scoreBulletify(reply: string, f: BulletifyFixture): ScoreResult {
  const out = stripFences(reply);
  const valid = out.trim() !== "";
  if (!valid) return finish(false, []);
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^([-*+]|\d+[.)])\s/.test(l));
  const first = lines[0] ?? "";
  const checks: CheckResult[] = [
    { name: "uses bullet points", pass: bulletLines.length >= 2, detail: `${bulletLines.length} bullets` },
    {
      name: "no preamble",
      pass: /^([-*+#]|\d+[.)]|\*\*)/.test(first),
      detail: first.slice(0, 60),
    },
    {
      name: "stays concise",
      pass: out.length <= f.content.length * 1.5,
      detail: `${out.length} vs ${f.content.length} chars`,
    },
    ...f.mustKeep.map((k) => ({ name: `keeps: ${k}`, pass: ci(out, k) })),
  ];
  return finish(true, checks, out);
}

// ---- merge ----

export function scoreMerge(reply: string, f: MergeFixture): ScoreResult {
  const out = stripFences(reply);
  const valid = out.trim() !== "";
  if (!valid) return finish(false, []);
  const combinedLen = f.notes.reduce((n, x) => n + x.content.length, 0);
  const checks: CheckResult[] = [
    {
      name: "deduplicates (shorter than sources combined)",
      pass: out.length < combinedLen,
      detail: `${out.length} vs ${combinedLen} chars`,
    },
    {
      name: "no preamble",
      pass: !/^(here|i('|’)ve|i have|sure|below)/i.test(out.trim()),
    },
    ...f.mustKeep.map((k) => ({ name: `keeps: ${k}`, pass: ci(out, k) })),
  ];
  return finish(true, checks, out);
}

// ---- collection summary ----

export function scoreSummary(reply: string, f: SummaryFixture): ScoreResult {
  const out = stripFences(reply);
  const valid = out.trim() !== "";
  if (!valid) return finish(false, []);
  const sentences = out.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 1);
  const themeHits = f.mustMentionAny.filter((k) => ci(out, k));
  const checks: CheckResult[] = [
    {
      name: "4-6 sentences",
      pass: sentences.length >= 4 && sentences.length <= 6,
      detail: `${sentences.length} sentences`,
    },
    {
      name: "single paragraph",
      pass: !out.includes("\n\n") && !out.trimStart().startsWith("#"),
    },
    {
      name: "no preamble/heading",
      pass: !/^(here|summary[:\s]|#)/i.test(out.trim()),
    },
    {
      name: "covers key themes (≥2)",
      pass: themeHits.length >= 2,
      detail: `hit: ${themeHits.join(", ") || "(none)"}`,
    },
  ];
  return finish(true, checks, out);
}
