// Self-contained HTML comparison report — models side by side, no external
// assets, openable straight from disk. Written automatically by runner.ts
// next to the results JSON, and runnable standalone:
//   npm run bench:html                  # latest file in bench/results/
//   npm run bench:html -- <path.json>   # specific results file

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate, type Agg } from "./report.ts";
import type { FeatureName, RunRecord } from "./types.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmt = {
  ms: (v?: number) =>
    v == null ? "—" : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v).toLocaleString()}ms`,
  pct: (v?: number) => (v == null ? "—" : `${Math.round(v * 100)}%`),
  num: (v?: number) => (v == null ? "—" : Math.round(v).toLocaleString()),
  score: (v?: number) => (v == null ? "—" : v.toFixed(2)),
  cost: (v?: number) => (v == null ? "—" : `$${v.toFixed(4)}`),
};

/** Score 0..1 → red→amber→green swatch, readable on the dark page. */
function scoreColor(v: number): string {
  const hue = Math.round(v * 120);
  return `hsl(${hue} 55% 30%)`;
}

function scoreCell(score?: number, sub?: string): string {
  if (score == null) return `<td class="empty">—</td>`;
  return (
    `<td style="background:${scoreColor(score)}">` +
    `<span class="cell-score">${fmt.score(score)}</span>` +
    (sub ? `<span class="cell-sub">${esc(sub)}</span>` : "") +
    `</td>`
  );
}

/** Basic description of each feature test — what is sent and what the checks grade. */
const FEATURE_DESCRIPTIONS: Record<FeatureName, string> = {
  title:
    "One note in, a 3–8 word title out. Fixtures: meeting notes, a recipe, a debugging log, a CI-flake postmortem, a one-line reminder. Checks: single-line reply, 3–8 words, fits 80 chars uncut, needs no quote/fence/punctuation cleanup, mentions the note's actual topic.",
  tags:
    "Suggest up to 2 tags and route the note to one of five folders, given an existing tag vocabulary. Includes a note that fits no folder (must return null rather than force a route) and one that should reuse an existing tag. Checks: respects the tag cap, no stopword/filler tags, tags are 1–2 lowercase words, at least one relevant tag suggested, exact folder match (or null).",
  actions:
    "Extract up to 6 action items as JSON with a category and a resolved due date — relative phrases like “tomorrow” and “friday” resolve against the run's pinned today. Includes a purely informational note with zero actions (must return an empty list), completed/handled items that must be skipped, and a 9-item braindump testing the 6-item cap. Checks: item count in the expected range, must-find / must-not-propose items, correctly resolved dates, every due hint parseable.",
  organize:
    "The worker's combined single call — title + tags + folder + action items in one reply — run on the same fixtures as tags. Same tag/folder checks, plus: proposes a title only for the untitled note (null for titled ones) and returns well-formed action items.",
  bulletify:
    "Restructure a stream-of-consciousness note into markdown bullets (an offsite plan, SSG research, an incident postmortem). Checks: actually uses bullets, no preamble, stays ≤1.5× the source length, preserves specific links, image refs, code identifiers and numbers.",
  merge:
    "Merge overlapping notes into one (two Tokyo-trip notes; three job-search notes, one untitled). Checks: deduplicates — the output must be shorter than the sources combined — no preamble, and keeps every load-bearing fact, link and name.",
  summary:
    "One 4–6 sentence paragraph synthesizing a note collection (six kitchen-renovation notes; five conference-talk-prep notes). Checks: sentence count, single paragraph, no heading or preamble, mentions at least two of the collection's key themes.",
};

export interface HtmlMeta {
  promptVersion?: number;
  judge?: string | null;
  source?: string;
  /** Pinned "today" the date fixtures grade against (config.today). */
  today?: string;
}

export function renderHtmlReport(records: RunRecord[], meta: HtmlMeta = {}): string {
  const models = [...new Set(records.map((r) => r.model))];
  const features = [...new Set(records.map((r) => r.feature))] as FeatureName[];
  const hasJudge = records.some((r) => r.judge != null);
  const hasCost = records.some((r) => r.costUsd != null);

  const overall = new Map(models.map((m) => [m, aggregate(records.filter((r) => r.model === m))]));
  const bestDet = Math.max(...[...overall.values()].map((a) => a.detScore ?? -1));
  const bestP50 = Math.min(...[...overall.values()].map((a) => a.latencyP50 ?? Infinity));

  // ---- overview table (rows = models) ----
  let overview = `<table><thead><tr><th>model</th><th>runs</th><th>errors</th><th>valid</th><th>det score</th>`;
  if (hasJudge) overview += `<th>judge</th>`;
  overview += `<th>p50</th><th>p95</th><th>in tok</th><th>out tok</th>`;
  if (hasCost) overview += `<th>cost/run</th>`;
  overview += `</tr></thead><tbody>`;
  for (const m of models) {
    const a = overall.get(m)!;
    const det = a.detScore != null && a.detScore === bestDet ? ` class="best"` : "";
    const p50 = a.latencyP50 != null && a.latencyP50 === bestP50 ? ` class="best"` : "";
    overview += `<tr><th>${esc(m)}</th><td>${a.runs}</td><td${a.errors > 0 ? ' class="bad"' : ""}>${a.errors}</td><td>${fmt.pct(a.validity)}</td><td${det}>${fmt.score(a.detScore)}</td>`;
    if (hasJudge) overview += `<td>${fmt.score(a.judgeScore)}</td>`;
    overview += `<td${p50}>${fmt.ms(a.latencyP50)}</td><td>${fmt.ms(a.latencyP95)}</td><td>${fmt.num(a.inTokens)}</td><td>${fmt.num(a.outTokens)}</td>`;
    if (hasCost) overview += `<td>${fmt.cost(a.costPerRun)}</td>`;
    overview += `</tr>`;
  }
  overview += `</tbody></table>`;

  // ---- the side-by-side centerpiece: feature rows × model columns ----
  let matrix = `<table class="matrix"><thead><tr><th>feature</th>${models.map((m) => `<th>${esc(m)}</th>`).join("")}</tr></thead><tbody>`;
  for (const f of features) {
    matrix += `<tr><th>${esc(f)}</th>`;
    for (const m of models) {
      const a: Agg = aggregate(records.filter((r) => r.model === m && r.feature === f));
      const sub =
        fmt.ms(a.latencyP50) +
        (hasJudge && a.judgeScore != null ? ` · judge ${fmt.score(a.judgeScore)}` : "") +
        (a.errors > 0 ? ` · ${a.errors} err` : "");
      matrix += scoreCell(a.detScore, sub);
    }
    matrix += `</tr>`;
  }
  // Bottom overall row mirrors the overview det scores for quick scanning.
  matrix += `<tr class="total"><th>overall</th>${models
    .map((m) => scoreCell(overall.get(m)!.detScore, fmt.ms(overall.get(m)!.latencyP50)))
    .join("")}</tr>`;
  matrix += `</tbody></table>`;

  // ---- what each test does ----
  const descs =
    `<p class="dim">Every test sends the app's exact prompt (from <code>prompts/prompts.json</code>) and parses the reply exactly the way <code>ai.rs</code> does. <b>valid</b> = the app could use the reply at all; <b>det score</b> = fraction of the checks below that passed.${meta.today ? ` Dates grade against a pinned “today” of ${esc(meta.today)}.` : ""}</p>` +
    `<dl>` +
    features
      .map((f) => `<dt>${esc(f)}</dt><dd>${esc(FEATURE_DESCRIPTIONS[f] ?? "")}</dd>`)
      .join("") +
    `</dl>`;

  // ---- fixture-level drilldown per feature ----
  let drill = "";
  for (const f of features) {
    const fixtures = [...new Set(records.filter((r) => r.feature === f).map((r) => r.fixture))];
    let t = `<table class="matrix"><thead><tr><th>fixture</th>${models.map((m) => `<th>${esc(m)}</th>`).join("")}</tr></thead><tbody>`;
    for (const fx of fixtures) {
      t += `<tr><th>${esc(fx)}</th>`;
      for (const m of models) {
        const a = aggregate(
          records.filter((r) => r.model === m && r.feature === f && r.fixture === fx),
        );
        t += scoreCell(a.detScore, fmt.ms(a.latencyP50));
      }
      t += `</tr>`;
    }
    t += `</tbody></table>`;
    drill += `<details><summary>${esc(f)}</summary>${t}</details>`;
  }

  // ---- failed checks, grouped by model ----
  let failures = "";
  for (const m of models) {
    const items: string[] = [];
    for (const r of records.filter((r) => r.model === m)) {
      if (r.error) {
        items.push(`<li><code>${esc(`${r.feature}/${r.fixture}`)}</code> run ${r.run}: <b class="bad">ERROR</b> ${esc(r.error)}</li>`);
        continue;
      }
      for (const c of r.score?.checks ?? []) {
        if (!c.pass) {
          items.push(
            `<li><code>${esc(`${r.feature}/${r.fixture}`)}</code> run ${r.run}: failed “${esc(c.name)}”${c.detail ? ` <span class="dim">(${esc(c.detail)})</span>` : ""}</li>`,
          );
        }
      }
    }
    if (items.length > 0) {
      failures += `<details><summary>${esc(m)} — ${items.length} failed check(s)</summary><ul>${items.join("")}</ul></details>`;
    }
  }

  const metaBits = [
    `${records.length} runs`,
    `${models.length} model(s)`,
    `${features.length} feature(s)`,
    meta.promptVersion != null ? `prompts v${meta.promptVersion}` : null,
    meta.judge ? `judge: ${meta.judge}` : null,
    meta.source ?? null,
    `generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NexusNote AI benchmark</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 2rem auto; max-width: 1100px; padding: 0 1.5rem; background: #0c0a09;
         color: #d6d3d1; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.3rem; color: #fafaf9; }
  h2 { font-size: 1.05rem; color: #fafaf9; margin-top: 2.2rem; }
  .meta { color: #78716c; font-size: 12px; }
  .legend { color: #78716c; font-size: 12px; margin: .4rem 0 1rem; }
  table { border-collapse: collapse; margin-top: .8rem; width: 100%; }
  th, td { border: 1px solid #292524; padding: .45rem .6rem; text-align: left;
           font-variant-numeric: tabular-nums; }
  thead th { background: #1c1917; color: #a8a29e; font-size: 12px; }
  tbody th { background: #171412; color: #e7e5e4; font-weight: 500; white-space: nowrap; }
  td.best { color: #dcb9a3; font-weight: 700; }
  td.bad, .bad { color: #fca5a5; }
  td.empty { color: #57534e; }
  .matrix td { text-align: center; }
  .cell-score { display: block; font-weight: 600; color: #fafaf9; }
  .cell-sub { display: block; font-size: 11px; color: rgba(250, 250, 249, .75); }
  .matrix tr.total th, .matrix tr.total td { border-top: 2px solid #44403c; }
  details { margin: .6rem 0; }
  summary { cursor: pointer; color: #a8a29e; }
  details ul { margin: .5rem 0 .8rem; padding-left: 1.4rem; }
  li { margin: .15rem 0; }
  code { background: #1c1917; padding: 0 .3rem; border-radius: 4px; font-size: 12.5px; }
  .dim { color: #78716c; }
  .descs dt { margin-top: .6rem; color: #e7e5e4; font-weight: 600; }
  .descs dd { margin: .15rem 0 0; color: #a8a29e; }
</style>
<h1>NexusNote AI feature benchmark</h1>
<p class="meta">${metaBits.map((b) => esc(String(b))).join(" · ")}</p>
<p class="legend"><b>det score</b> = fraction of deterministic checks passed (0–1), cell shading red→green · sub-line = p50 latency${hasJudge ? " · judge = Claude-graded quality (1–5)" : ""} · <b>valid</b> = reply parseable the way the app parses it.</p>

<h2>Feature × model</h2>
${matrix}
<details class="descs"><summary>What each test does</summary>${descs}</details>

<h2>Overall</h2>
${overview}

<h2>Per-fixture drilldown</h2>
${drill || `<p class="dim">No records.</p>`}

<h2>Failed checks</h2>
${failures || `<p class="dim">None 🎉</p>`}
</html>
`;
}

function latestResultsFile(resultsDir: string): string {
  const files = readdirSync(resultsDir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort();
  const last = files[files.length - 1];
  if (!last) throw new Error(`no run-*.json files in ${resultsDir}`);
  return path.join(resultsDir, last);
}

function main(): void {
  const benchDir = path.resolve(import.meta.dirname, "..");
  const file = process.argv[2] ?? latestResultsFile(path.join(benchDir, "results"));
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    config?: { promptVersion?: number; judge?: string | null; today?: string };
    records: RunRecord[];
  };
  const html = renderHtmlReport(data.records, {
    promptVersion: data.config?.promptVersion,
    judge: data.config?.judge ?? null,
    source: path.basename(file),
    today: data.config?.today,
  });
  const out = file.replace(/\.json$/, ".html");
  writeFileSync(out, html);
  console.log(`HTML report: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
