// Benchmark runner: model × feature × fixture × N runs, sequential per model
// so latency numbers stay clean. Saves raw results JSON + a markdown report
// under bench/results/.
//
//   npm run bench                               # everything in bench.config.json
//   npm run bench -- --models ollama-llama3.2   # subset of models
//   npm run bench -- --features title,tags      # subset of features
//   npm run bench -- --runs 1 --judge           # quick pass with LLM judge
//   npm run bench -- --dry-run                  # print prompts, call nothing

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { judgeOutput } from "./judge.ts";
import {
  buildActions,
  buildBulletify,
  buildMerge,
  buildSummarize,
  buildTagRoute,
  buildTitle,
} from "./prompts.ts";
import { chat, estimateCostUsd } from "./providers.ts";
import { renderReport } from "./report.ts";
import {
  scoreActions,
  scoreBulletify,
  scoreMerge,
  scoreSummary,
  scoreTags,
  scoreTitle,
} from "./scoring.ts";
import {
  ALL_FEATURES,
  type BenchConfig,
  type BuiltRequest,
  type FeatureName,
  type Fixtures,
  type RunRecord,
  type ScoreResult,
} from "./types.ts";

interface BenchCase {
  feature: FeatureName;
  fixture: string;
  request: BuiltRequest;
  score: (reply: string) => ScoreResult;
  /** Human-readable input handed to the LLM judge. */
  judgeInput: string;
}

function buildCases(fixtures: Fixtures, today: string): BenchCase[] {
  const cases: BenchCase[] = [];
  for (const f of fixtures.title) {
    cases.push({
      feature: "title",
      fixture: f.id,
      request: buildTitle(f.content),
      score: (r) => scoreTitle(r, f),
      judgeInput: `NOTE CONTENT:\n${f.content}`,
    });
  }
  for (const f of fixtures.tags) {
    cases.push({
      feature: "tags",
      fixture: f.id,
      request: buildTagRoute(f),
      score: (r) => scoreTags(r, f),
      judgeInput: `FOLDERS: ${f.folders.join(", ")}\nEXISTING TAGS: ${f.existingTags.join(", ")}\nNOTE TITLE: ${f.title}\nNOTE CONTENT:\n${f.content}`,
    });
  }
  for (const f of fixtures.actions) {
    cases.push({
      feature: "actions",
      fixture: f.id,
      request: buildActions({ ...f, today }),
      score: (r) => scoreActions(r, f),
      judgeInput: `TODAY: ${today}\nNOTE TITLE: ${f.title}\nNOTE CONTENT:\n${f.content}`,
    });
  }
  for (const f of fixtures.bulletify) {
    cases.push({
      feature: "bulletify",
      fixture: f.id,
      request: buildBulletify(f.content),
      score: (r) => scoreBulletify(r, f),
      judgeInput: `NOTE CONTENT:\n${f.content}`,
    });
  }
  for (const f of fixtures.merge) {
    cases.push({
      feature: "merge",
      fixture: f.id,
      request: buildMerge(f.notes),
      score: (r) => scoreMerge(r, f),
      judgeInput: f.notes.map((n) => `NOTE "${n.title}":\n${n.content}`).join("\n\n"),
    });
  }
  for (const f of fixtures.summary) {
    cases.push({
      feature: "summary",
      fixture: f.id,
      request: buildSummarize(f.notes),
      score: (r) => scoreSummary(r, f),
      judgeInput: f.notes.map((n) => `NOTE "${n.title}":\n${n.content}`).join("\n\n"),
    });
  }
  return cases;
}

// ---- CLI args ----

interface Args {
  config?: string;
  models?: string[];
  features?: FeatureName[];
  runs?: number;
  judge: boolean;
  judgeModel?: string;
  out?: string;
  dryRun: boolean;
}

const USAGE = `Usage: npm run bench -- [options]
  --config <path>        config file (default: bench/bench.config.json)
  --models a,b           run only these models (names from config)
  --features a,b         run only these features (${ALL_FEATURES.join(", ")})
  --runs <n>             runs per case (default: config.runs)
  --judge                add an LLM-judged quality score (uses Anthropic API)
  --judge-model <id>     judge model (default: config.judge.model or claude-opus-4-8)
  --out <path>           results JSON path (default: bench/results/run-<ts>.json)
  --dry-run              print the prompts each case would send, then exit`;

function parseArgs(argv: string[]): Args {
  const args: Args = { judge: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--config": args.config = next(); break;
      case "--models": args.models = next().split(",").map((s) => s.trim()); break;
      case "--features": {
        const fs = next().split(",").map((s) => s.trim()) as FeatureName[];
        for (const f of fs) {
          if (!ALL_FEATURES.includes(f)) throw new Error(`unknown feature "${f}"`);
        }
        args.features = fs;
        break;
      }
      case "--runs": args.runs = Number(next()); break;
      case "--judge": args.judge = true; break;
      case "--judge-model": args.judgeModel = next(); break;
      case "--out": args.out = next(); break;
      case "--dry-run": args.dryRun = true; break;
      case "--help": case "-h": console.log(USAGE); process.exit(0); break;
      default: throw new Error(`unknown argument "${a}"\n\n${USAGE}`);
    }
  }
  return args;
}

// ---- main ----

const args = parseArgs(process.argv.slice(2));
const benchDir = path.resolve(import.meta.dirname, "..");
const configPath = args.config ?? path.join(benchDir, "bench.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as BenchConfig;
const fixtures = JSON.parse(
  readFileSync(path.join(benchDir, "fixtures", "fixtures.json"), "utf8"),
) as Fixtures;

let cases = buildCases(fixtures, config.today);
if (args.features) cases = cases.filter((c) => args.features!.includes(c.feature));

let models = config.models;
if (args.models) {
  models = models.filter((m) => args.models!.includes(m.name));
  const missing = args.models.filter((n) => !models.some((m) => m.name === n));
  if (missing.length > 0) throw new Error(`models not in config: ${missing.join(", ")}`);
}
if (models.length === 0) throw new Error("no models selected");
if (cases.length === 0) throw new Error("no cases selected");

const runs = args.runs ?? config.runs ?? 3;
const judgeModel = args.judgeModel ?? config.judge?.model ?? "claude-opus-4-8";

if (args.dryRun) {
  for (const c of cases) {
    console.log(`\n━━━ ${c.feature}/${c.fixture} (max_tokens=${c.request.maxTokens}${c.request.schema ? ", json_schema" : ""}) ━━━`);
    console.log(`[system] ${c.request.system}`);
    console.log(`[user]\n${c.request.user}`);
  }
  console.log(
    `\n${cases.length} cases × ${runs} runs × ${models.length} models = ${cases.length * runs * models.length} requests (dry run — nothing sent)`,
  );
  process.exit(0);
}

console.log(
  `Benchmark: ${models.length} model(s) × ${cases.length} case(s) × ${runs} run(s)` +
    (args.judge ? ` + judge (${judgeModel})` : ""),
);

const records: RunRecord[] = [];
for (const m of models) {
  console.log(`\n=== ${m.name} (${m.provider}: ${m.model}) ===`);
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const rec: RunRecord = {
        model: m.name,
        feature: c.feature,
        fixture: c.fixture,
        run,
        ok: false,
        latencyMs: 0,
      };
      const t0 = performance.now();
      try {
        const resp = await chat(m, c.request);
        rec.latencyMs = Math.round(performance.now() - t0);
        rec.ok = true;
        rec.raw = resp.text;
        rec.inputTokens = resp.inputTokens;
        rec.outputTokens = resp.outputTokens;
        rec.costUsd = estimateCostUsd(m, resp.inputTokens, resp.outputTokens);
        rec.score = c.score(resp.text);
      } catch (e) {
        rec.latencyMs = Math.round(performance.now() - t0);
        rec.error = e instanceof Error ? e.message : String(e);
      }
      if (args.judge && rec.ok && rec.raw !== undefined) {
        try {
          rec.judge = await judgeOutput(judgeModel, c.feature, c.judgeInput, rec.raw);
        } catch (e) {
          console.warn(`  judge failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      records.push(rec);
      if (rec.error) {
        console.log(`  ${c.feature}/${c.fixture} #${run}: ERROR ${rec.error}`);
      } else {
        const s = rec.score!;
        console.log(
          `  ${c.feature}/${c.fixture} #${run}: ${rec.latencyMs}ms ` +
            `${s.valid ? "✓" : "✗ invalid"} score=${s.score.toFixed(2)}` +
            (rec.judge ? ` judge=${rec.judge.score}` : ""),
        );
      }
    }
  }
}

const outDir = path.join(benchDir, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = args.out ?? path.join(outDir, `run-${stamp}.json`);
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      config: { today: config.today, runs, judge: args.judge ? judgeModel : null, models: models.map((m) => m.name) },
      records,
    },
    null,
    2,
  ),
);
const md = renderReport(records);
const mdPath = jsonPath.replace(/\.json$/, ".md");
writeFileSync(mdPath, md);

console.log("\n" + md);
console.log(`Results: ${jsonPath}`);
console.log(`Report:  ${mdPath}`);
