// npm run eval [-- --no-results]: runs every input_examples/*.json in name order, then every case in
// evals/redteam/cases.json, in one process, and checks each result against evals/expectations.json or the case's
// expect block (no_query reads the run's trace), the checks every result gets, and the trace path of its task. Prints a table and exits 1 on any
// failure. A plain run writes evals/RESULTS.md: a sample-mode run replaces its "Sample mode" section, a real-model
// run appends a "Real model, run <n>" section. --no-results (npm run check) writes nothing.
//
// Mode: sample unless the shell sets SAMPLE_MODE=false (--env-file never overrides a shell value, and .env leaves
// SAMPLE_MODE empty). SAMPLE_MODE=true wins over each input's options.sample_mode, as in POST /run. Data: every run
// uses a fixture data dir from make-fixtures.ts (base unless the case names one), so memory starts empty each eval
// run and data/ is never touched. Loads .env through node --env-file; it never opens it. Runs under tsx as
// CommonJS: async main(), no top-level await.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, makeFixtures } from "./make-fixtures";
import type { CaseCheck, Expectation, TraceLine } from "../src/agent/eval-checks";
import type { RunResult } from "../src/agent/orchestrator";
import { promptVersion } from "../src/agent/prompts";

const ROOT = process.cwd();
const INPUTS = path.join(ROOT, "input_examples");
const EXPECTATIONS = path.join(ROOT, "evals", "expectations.json");
const CASES = path.join(ROOT, "evals", "redteam", "cases.json");
const RESULTS = path.join(ROOT, "evals", "RESULTS.md");
const BASE_DIR = path.join(FIXTURES_DIR, "base");

type RedTeamCase = { id: string; data_dir?: string; input: Record<string, unknown>; expect: Expectation };
type Row = { id: string; verdict: "pass" | "fail" | "skipped" | "rate-limited"; result: RunResult | null; failed: CaseCheck[]; seconds: number };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function shortCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function traceOf(runId: string): TraceLine[] {
  const file = path.join(ROOT, "logs", `trace-${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceLine);
}

/** The Evaluator total, or "score unavailable" when the Evaluator accepted the draft unscored; never 0 for a missing score. */
function totalCell(row: Row): string {
  const total = row.result?.output?.scores?.total;
  if (typeof total === "number") return String(total);
  if (row.result === null) return "-";
  return traceOf(row.id).some((line) => line.agent_name === "Evaluator" && line.action === "score_unavailable") ? "score unavailable" : "-";
}

const cell = (value: unknown): string => (value === null || value === undefined ? "-" : String(value).replace(/\|/g, "/"));

function tableLines(rows: Row[]): string[] {
  const header = "| case | result | status | citations | rounds | Evaluator total | model calls | query calls | tokens | seconds | failed check |";
  const lines = [header, "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const row of rows) {
    const r = row.result;
    const failed = row.failed.map((c) => `${c.name}: ${c.detail}`).join("; ");
    lines.push(
      `| ${row.id} | ${row.verdict} | ${cell(r?.status)} | ${cell(r?.output?.citations.length)} | ${cell(r?.output?.rounds)} | ${totalCell(row)} | ${cell(r?.usage?.model_calls)} | ${cell(r?.usage?.query_calls)} | ${r === null ? "-" : r.usage.tokens_in + r.usage.tokens_out} | ${row.verdict === "skipped" ? "-" : row.seconds.toFixed(2)} | ${cell(failed || (row.verdict === "skipped" ? "input file not written yet" : ""))} |`,
    );
  }
  return lines;
}

/** "Prompts: planner <hash>, analyst <hash>, evaluator <hash>, writer <hash>": the prompt versions this section measured. */
function promptsLine(): string {
  return `Prompts: ${["planner", "analyst", "evaluator", "writer"].map((name) => `${name} ${promptVersion(name).prompt_hash}`).join(", ")}`;
}

/** routed_model of the first model_call line that has one, and the sum of cost_usd over every model_call line. */
function modelStats(runIds: string[]): { routed: string; cost: string } {
  let routed: string | null = null;
  let cost = 0;
  let costSeen = false;
  for (const id of runIds) {
    for (const line of traceOf(id)) {
      if (line.action !== "model_call") continue;
      if (routed === null && typeof line.routed_model === "string" && line.routed_model !== "") routed = line.routed_model;
      if (typeof line.cost_usd === "number" && Number.isFinite(line.cost_usd)) {
        cost += line.cost_usd;
        costSeen = true;
      }
    }
  }
  return { routed: routed ?? "none", cost: costSeen ? `${cost.toFixed(6)} USD` : "unknown" };
}

function writeResults(rows: Row[], real: boolean, meta: { commit: string; models: { strong?: string; main?: string; fast?: string }; host: string }): void {
  const date = new Date().toISOString().slice(0, 10);
  const { routed, cost } = modelStats(rows.filter((row) => row.result !== null).map((row) => row.id));
  const totals = { pass: rows.filter((r) => r.verdict === "pass").length, fail: rows.filter((r) => r.verdict === "fail").length, skipped: rows.filter((r) => r.verdict === "skipped").length, limited: rows.filter((r) => r.verdict === "rate-limited").length };
  const existing = existsSync(RESULTS) ? readFileSync(RESULTS, "utf8") : "# Eval results\n\nWritten by `npm run eval`. Each row is one input example or red-team case; see `scripts/eval.ts` for the checks.\n";
  const runNumber = (existing.match(/^## Real model, run \d+/gm) ?? []).length + 1;
  const heading = real ? `## Real model, run ${runNumber} (${date})` : `## Sample mode (${date})`;
  const facts = [
    `- Date: ${date}`,
    `- Mode: ${real ? "real model" : "sample"}`,
    `- ${promptsLine()}`,
    ...(real ? [`- Provider host: ${meta.host}`, `- Models: strong ${meta.models.strong ?? "unset"}, main ${meta.models.main ?? "unset"}, fast ${meta.models.fast ?? "unset"}`] : []),
    `- routed_model (first real model call): ${routed}`,
    `- cost_usd (sum over every model call): ${cost}`,
    ...(real ? [`- Commit: ${meta.commit}`] : []),
    `- Totals: ${totals.pass} passed, ${totals.fail} failed, ${totals.skipped} skipped${totals.limited > 0 ? `, ${totals.limited} rate-limited` : ""}`,
  ];
  const section = [heading, "", ...facts, "", ...tableLines(rows), ""].join("\n");
  let next: string;
  if (real) {
    next = `${existing.trimEnd()}\n\n${section}`;
  } else {
    const start = existing.search(/^## Sample mode/m);
    if (start >= 0) {
      const after = existing.slice(start + 1).search(/^## /m);
      const end = after < 0 ? existing.length : start + 1 + after;
      next = `${existing.slice(0, start)}${section}${after < 0 ? "" : `\n${existing.slice(end)}`}`;
    } else {
      const real1 = existing.search(/^## Real model/m);
      next = real1 < 0 ? `${existing.trimEnd()}\n\n${section}` : `${existing.slice(0, real1)}${section}\n${existing.slice(real1)}`;
    }
  }
  writeFileSync(RESULTS, `${next.trimEnd()}\n`);
}

async function main(argv: string[]): Promise<number> {
  const noResults = argv.includes("--no-results");
  const unknown = argv.filter((arg) => arg !== "--no-results");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option ${unknown.join(" ")}.\nUsage: npm run eval [-- --no-results]\n`);
    return 2;
  }
  const commit = shortCommit();
  makeFixtures();
  const real = (process.env.SAMPLE_MODE ?? "").trim().toLowerCase() === "false";
  if (!real) process.env.SAMPLE_MODE = "true";
  process.env.TRADEFLOW_DATA_DIR = BASE_DIR;

  const { runRequest } = await import("../src/agent/request");
  const { loadConfig } = await import("../src/agent/config");
  const checks = await import("../src/agent/eval-checks");

  const expectations = readJson<Record<string, Expectation>>(EXPECTATIONS);
  const cases = readJson<RedTeamCase[]>(CASES);
  const files = readdirSync(INPUTS).filter((name) => name.endsWith(".json")).sort();
  const rows: Row[] = [];

  const runOne = async (id: string, body: unknown, exp: Expectation | undefined, dataDir: string | undefined) => {
    process.env.TRADEFLOW_DATA_DIR = dataDir === undefined ? BASE_DIR : path.resolve(ROOT, dataDir);
    const localReason = dataDir === undefined ? undefined : `eval fixture ${dataDir} is not in Postgres: every query runs locally`;
    const started = Date.now();
    const result = await runRequest(body, localReason === undefined ? {} : { localReason });
    const seconds = (Date.now() - started) / 1000;
    if (result.status === "error" && result.error?.type === "RateLimited") {
      rows.push({ id, verdict: "rate-limited", result, failed: [], seconds });
      return;
    }
    const all = [...(exp === undefined ? [] : checks.checkExpectation(result, exp, real, traceOf(id))), ...checks.universalChecks(result), ...checks.tracePathChecks(id, result, traceOf(id))];
    const failed = all.filter((c) => !c.pass);
    rows.push({ id, verdict: failed.length === 0 ? "pass" : "fail", result, failed, seconds });
    process.stdout.write(`${failed.length === 0 ? "pass" : "FAIL"} ${id}: ${result.status}${failed.length === 0 ? "" : ` (${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")})`}\n`);
  };

  for (const file of files) {
    const id = path.basename(file, ".json");
    const body = readJson<Record<string, unknown>>(path.join(INPUTS, file));
    await runOne(id, { ...body, run_id: id }, expectations[id], undefined);
  }
  for (const id of Object.keys(expectations)) {
    if (!files.includes(`${id}.json`)) rows.push({ id, verdict: "skipped", result: null, failed: [], seconds: 0 });
  }
  for (const item of cases) {
    await runOne(item.id, { run_id: item.id, input: item.input }, item.expect, item.data_dir);
  }

  process.stdout.write(`\n${tableLines(rows).join("\n")}\n`);
  const fails = rows.filter((row) => row.verdict === "fail").length;
  const passes = rows.filter((row) => row.verdict === "pass").length;
  const skipped = rows.filter((row) => row.verdict === "skipped").length;
  const limited = rows.filter((row) => row.verdict === "rate-limited").length;
  process.stdout.write(`\n${passes} passed, ${fails} failed, ${skipped} skipped${limited > 0 ? `, ${limited} rate-limited` : ""} (${real ? "real model" : "sample mode"})\n`);

  if (!noResults) {
    const config = loadConfig(process.env, () => {});
    let host = "unknown";
    try {
      host = new URL(process.env.METERLESS_BASE_URL ?? "").hostname || "unknown";
    } catch {
      host = "unknown";
    }
    writeResults(rows, real, { commit, models: config.models, host });
    process.stdout.write(`wrote ${path.relative(ROOT, RESULTS)}\n`);
  }
  return fails > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
