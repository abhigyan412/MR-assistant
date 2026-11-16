// Eval runner: npm run eval -- [--provider openai] [--models a,b] [--effort medium] [--cases N01,N05] [--concurrency 4]
//
// Runs every text case (and any voice case whose recording exists — Phase 2)
// through the real extraction path (lib/extract.ts) with the MR shortlist
// built from seed-data, scores it, prints a report and writes JSON results
// to eval/results/. Needs the selected provider's API key (ANTHROPIC_API_KEY
// or OPENAI_API_KEY); does NOT need the database.

import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { contextFromSeed } from "../lib/context";
import { extractNote, type ExtractOutcome } from "../lib/extract";
import { API_KEY_ENV, createProvider, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../lib/llm";
import { samplingFor } from "../lib/llm/openai";
import { PROMPT_VERSION } from "../lib/prompts";
import { CASES, DEFAULT_MR, type EvalCase } from "./cases";
import { OPENING_STOCK } from "../prisma/seed-data";
import { scoreCase, scorePipeline, type CaseScore, type PipelineScore } from "./score";

const NOTES_PER_MR_MONTH = 500;

// Approximate list prices, USD per million tokens (Nov 2026). Estimates only.
// cacheRead = cached-input rate; OpenAI has no cache-write charge.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // OpenAI standard tier, developers.openai.com/api/docs/pricing (checked 2026-11-17).
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
};

interface CaseResult {
  id: string;
  status: "scored" | "error" | "skipped";
  reason?: string;
  score?: CaseScore;
  pipeline?: PipelineScore | null;
  outcome?: Omit<ExtractOutcome, "extraction"> & { extraction: unknown };
  costUsd?: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function costOf(model: string, outcome: ExtractOutcome): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const u = outcome.result.usage;
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

// Spend cap across the whole run (--budget USD). Checked before each note, so
// with N notes in flight the overshoot is at most N-1 notes.
let spentUsd = 0;
let budgetUsd = Infinity;

async function runCase(c: EvalCase, providerId: string, model: string, effort: string): Promise<CaseResult> {
  if (spentUsd >= budgetUsd) {
    return { id: c.id, status: "skipped", reason: `budget cap $${budgetUsd} reached` };
  }
  if (c.pipelineOnly || !c.expect) {
    return { id: c.id, status: "skipped", reason: "pipeline-only (Phase 1)" };
  }
  if (c.kind === "voice") {
    const hasAudio = c.audioFile && existsSync(c.audioFile);
    return {
      id: c.id,
      status: "skipped",
      reason: hasAudio ? "recording present; transcription is Phase 2" : "pending recording",
    };
  }
  const ctx = contextFromSeed(c.mr ?? DEFAULT_MR);
  const provider = createProvider({ provider: providerId, model, effort });
  try {
    const outcome = await extractNote(provider, ctx, c.note);
    const score = scoreCase(c, outcome.extraction, ctx, outcome.unknownRefs);
    const stock = new Map(Object.entries(OPENING_STOCK[c.mr ?? DEFAULT_MR] ?? {}));
    const pipeline = scorePipeline(c, outcome.extraction, ctx, stock);
    const costUsd = costOf(model, outcome);
    spentUsd += costUsd ?? 0;
    return { id: c.id, status: "scored", score, pipeline, outcome, costUsd };
  } catch (err) {
    return { id: c.id, status: "error", reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  // --models a,b:low,c  — an optional ":effort" per model overrides --effort.
  const defaultEffort = arg("effort") ?? process.env.LLM_EFFORT ?? DEFAULT_EFFORT;
  const runs = (arg("models") ?? process.env.LLM_MODEL ?? DEFAULT_MODEL).split(",").map((m) => {
    const [model, effort] = m.trim().split(":");
    return { model, effort: effort ?? defaultEffort };
  });
  if (arg("budget")) budgetUsd = Number(arg("budget"));
  const only = arg("cases")?.split(",").map((s) => s.trim());
  const concurrency = Number(arg("concurrency") ?? 4);
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;

  const providerId = arg("provider") ?? process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER;
  const keyEnv = API_KEY_ENV[providerId];
  if (!keyEnv) {
    console.error(`Unknown provider "${providerId}" (expected ${Object.keys(API_KEY_ENV).join(", ")})`);
    process.exit(1);
  }
  if (!process.env[keyEnv]) {
    console.error(`${keyEnv} is not set. Add it to .env (see .env.example).`);
    process.exit(1);
  }

  if (Number.isFinite(budgetUsd)) {
    const unpriced = runs.filter((r) => !PRICES[r.model]).map((r) => r.model);
    if (unpriced.length) {
      console.error(`--budget needs a price for every model; none for: ${unpriced.join(", ")} (add to PRICES)`);
      process.exit(1);
    }
  }

  mkdirSync("eval/results", { recursive: true });
  const summaries: string[] = [];
  const board: { label: string; critical: number; errors: number; budgetSkipped: number; perNote?: number }[] = [];

  for (const { model, effort } of runs) {
    console.log(`\n=== ${providerId}/${model} · effort ${effort} · prompt ${PROMPT_VERSION} · ${cases.length} cases ===`);
    const started = Date.now();
    const results = await pool(cases, concurrency, (c) => runCase(c, providerId, model, effort));

    for (const r of results) {
      if (r.status === "skipped") {
        console.log(`  ${r.id.padEnd(4)} SKIP  ${r.reason}`);
      } else if (r.status === "error") {
        console.log(`  ${r.id.padEnd(4)} ERROR ${r.reason}`);
      } else {
        const s = r.score!;
        const failed = s.checks.filter((c) => !c.pass);
        const flag = s.pass ? "PASS " : s.criticalFailures > 0 ? "CRIT " : "FAIL ";
        console.log(`  ${r.id.padEnd(4)} ${flag} ${s.checks.length - failed.length}/${s.checks.length} checks`);
        for (const f of failed) {
          console.log(`         ${f.critical ? "!!" : "- "} ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
        }
        if (r.pipeline && !r.pipeline.pass) {
          console.log(`         ~  pipeline: expected ${r.pipeline.expected}, got ${r.pipeline.got}`);
        }
      }
    }

    const scored = results.filter((r) => r.status === "scored");
    const errors = results.filter((r) => r.status === "error").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const casesPassed = scored.filter((r) => r.score!.pass).length;
    const checks = scored.flatMap((r) => r.score!.checks);
    const checksPassed = checks.filter((c) => c.pass).length;
    const critical = scored.reduce((n, r) => n + r.score!.criticalFailures, 0);
    const leaks = scored.reduce((n, r) => n + r.score!.privacyLeaks, 0);
    const pipelines = scored.map((r) => r.pipeline).filter((p): p is PipelineScore => !!p);
    const pipelinePassed = pipelines.filter((p) => p.pass).length;
    const cost = scored.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    const latencies = scored.map((r) => r.outcome!.result.latencyMs).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
    const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const budgetSkipped = results.filter((r) => r.status === "skipped" && r.reason?.startsWith("budget")).length;
    const sampling = providerId === "openai" ? samplingFor(model) : undefined;
    const label = `${model}@${effort}`;
    const priced = scored.filter((r) => r.costUsd !== undefined);
    const perNote = priced.length ? priced.reduce((n, r) => n + r.costUsd!, 0) / priced.length : undefined;
    const servedBy = [...new Set(scored.map((r) => r.outcome!.result.model))].join(", ");

    const line =
      `${label.padEnd(22)} extraction: cases ${casesPassed}/${scored.length + errors} · checks ${checksPassed}/${checks.length}` +
      ` · pipeline outcome ${pipelinePassed}/${pipelines.length}` +
      ` · critical ${critical} · patient leaks ${leaks} · errors ${errors} · skipped ${skipped}` +
      ` · avg ${(avg / 1000).toFixed(1)}s · p50 ${(p50 / 1000).toFixed(1)}s · p95 ${(p95 / 1000).toFixed(1)}s` +
      (perNote === undefined
        ? " · cost: no price for this model"
        : ` · est. $${cost.toFixed(4)} ($${perNote.toFixed(5)}/note, $${(perNote * NOTES_PER_MR_MONTH).toFixed(2)}/MR/month @ ${NOTES_PER_MR_MONTH} notes)`);
    console.log(`\n${line}`);
    console.log(
      `served by: ${servedBy || "-"}${sampling ? ` · sampling: ${sampling === "temperature" ? "temperature 0" : sampling === "reasoning" ? `reasoning effort ${effort}` : "API defaults"}` : ""}` +
        ` · wall time ${((Date.now() - started) / 1000).toFixed(0)}s · run spend so far $${spentUsd.toFixed(4)}`
    );
    if (budgetSkipped) console.log(`!! budget cap reached: ${budgetSkipped} notes not run for this model`);
    summaries.push(line);
    board.push({ label, critical, errors, budgetSkipped, perNote });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `eval/results/${stamp}-${model}-${effort}.json`;
    writeFileSync(
      file,
      JSON.stringify({ model, effort, promptVersion: PROMPT_VERSION, ranAt: new Date().toISOString(), results }, null, 2)
    );
    console.log(`results: ${file}`);
  }

  if (summaries.length > 1) {
    console.log("\n=== Summary ===");
    for (const s of summaries) console.log(s);
  }
  // Production pick: cheapest per note among runs with zero critical errors,
  // zero provider errors and every note actually run.
  const clean = board.filter((b) => b.critical === 0 && b.errors === 0 && b.budgetSkipped === 0 && b.perNote !== undefined);
  clean.sort((a, b) => a.perNote! - b.perNote!);
  console.log(
    clean.length
      ? `\n>>> PRODUCTION PICK: ${clean[0].label} — cheapest with zero critical errors ($${clean[0].perNote!.toFixed(5)}/note, $${(clean[0].perNote! * NOTES_PER_MR_MONTH).toFixed(2)}/MR/month)`
      : "\n>>> PRODUCTION PICK: none — every run had critical errors, provider errors, or was cut by the budget"
  );
  console.log(`Total spend this run: $${spentUsd.toFixed(4)}${Number.isFinite(budgetUsd) ? ` (cap $${budgetUsd})` : ""}`);
  console.log("\nPipeline outcome = final status + review-card kinds after the deterministic checks (offline, seed stock).");
  console.log("The resent duplicate (N14) and DB behaviour are covered by tests/pipeline.db.test.ts.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
