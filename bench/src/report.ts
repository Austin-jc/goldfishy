// Aggregates run records into a markdown report. Used by runner.ts at the end
// of a run, and runnable standalone to re-render a saved results file:
//   npm run bench:report                  # latest file in bench/results/
//   npm run bench:report -- <path.json>   # specific results file

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FeatureName, RunRecord } from "./types.ts";

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

function mean(xs: number[]): number | undefined {
  return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;
}

const fmt = {
  ms: (v?: number) => (v == null ? "—" : `${Math.round(v).toLocaleString()}ms`),
  pct: (v?: number) => (v == null ? "—" : `${Math.round(v * 100)}%`),
  num: (v?: number) => (v == null ? "—" : Math.round(v).toLocaleString()),
  score: (v?: number) => (v == null ? "—" : v.toFixed(2)),
  cost: (v?: number) => (v == null ? "—" : `$${v.toFixed(4)}`),
};

interface Agg {
  runs: number;
  errors: number;
  validity?: number;
  detScore?: number;
  judgeScore?: number;
  latencyP50?: number;
  latencyP95?: number;
  inTokens?: number;
  outTokens?: number;
  costPerRun?: number;
}

function aggregate(records: RunRecord[]): Agg {
  const done = records.filter((r) => r.ok);
  return {
    runs: records.length,
    errors: records.length - done.length,
    validity: done.length ? done.filter((r) => r.score?.valid).length / done.length : undefined,
    detScore: mean(done.map((r) => r.score?.score).filter((v): v is number => v != null)),
    judgeScore: mean(done.map((r) => r.judge?.score).filter((v): v is number => v != null)),
    latencyP50: median(done.map((r) => r.latencyMs)),
    latencyP95: p95(done.map((r) => r.latencyMs)),
    inTokens: mean(done.map((r) => r.inputTokens).filter((v): v is number => v != null)),
    outTokens: mean(done.map((r) => r.outputTokens).filter((v): v is number => v != null)),
    costPerRun: mean(done.map((r) => r.costUsd).filter((v): v is number => v != null)),
  };
}

function tableRow(model: string, a: Agg): string {
  return `| ${model} | ${a.runs} | ${a.errors} | ${fmt.pct(a.validity)} | ${fmt.score(a.detScore)} | ${fmt.score(a.judgeScore)} | ${fmt.ms(a.latencyP50)} | ${fmt.ms(a.latencyP95)} | ${fmt.num(a.inTokens)} | ${fmt.num(a.outTokens)} | ${fmt.cost(a.costPerRun)} |`;
}

const TABLE_HEADER = `| model | runs | errors | valid | det score | judge | p50 latency | p95 latency | in tok | out tok | cost/run |
|---|---|---|---|---|---|---|---|---|---|---|`;

export function renderReport(
  records: RunRecord[],
  meta?: { promptVersion?: number },
): string {
  const models = [...new Set(records.map((r) => r.model))];
  const features = [...new Set(records.map((r) => r.feature))] as FeatureName[];

  let out = `# NexusNote AI feature benchmark\n\n`;
  out += `${records.length} runs · ${models.length} model(s) · ${features.length} feature(s)`;
  if (meta?.promptVersion != null) out += ` · prompts v${meta.promptVersion}`;
  out += `\n\n`;
  out += `Scores: **valid** = reply parseable the way the app parses it · **det score** = fraction of deterministic checks passed (0-1) · **judge** = optional Claude-judged quality (1-5).\n\n`;

  out += `## Overall\n\n${TABLE_HEADER}\n`;
  for (const m of models) {
    out += tableRow(m, aggregate(records.filter((r) => r.model === m))) + "\n";
  }

  for (const f of features) {
    out += `\n## ${f}\n\n${TABLE_HEADER}\n`;
    for (const m of models) {
      out += tableRow(m, aggregate(records.filter((r) => r.model === m && r.feature === f))) + "\n";
    }
  }

  // Failed checks worth a look (capped so the report stays readable).
  const failures: string[] = [];
  for (const r of records) {
    if (r.error) {
      failures.push(`- **${r.model}** ${r.feature}/${r.fixture} run ${r.run}: ERROR ${r.error}`);
      continue;
    }
    for (const c of r.score?.checks ?? []) {
      if (!c.pass) {
        failures.push(
          `- **${r.model}** ${r.feature}/${r.fixture} run ${r.run}: failed "${c.name}"${c.detail ? ` (${c.detail})` : ""}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    out += `\n## Failed checks (${failures.length})\n\n`;
    out += failures.slice(0, 80).join("\n") + "\n";
    if (failures.length > 80) out += `\n…and ${failures.length - 80} more (see the results JSON).\n`;
  }
  return out;
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
    config?: { promptVersion?: number };
    records: RunRecord[];
  };
  console.log(`Rendering ${file}\n`);
  console.log(renderReport(data.records, { promptVersion: data.config?.promptVersion }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
