// The parts of npm run eval that tests can call: the case list in the usual order, running the cases one group at a
// time or N groups at once (scripts/case-chains.ts), turning each result into a row, and the RESULTS.md table. The
// rows always come out in the usual case order, whatever order the cases finished in. scripts/eval.ts wires these
// together; scripts/eval-worker.ts runs one group in a child process.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type * as EvalChecks from "../src/agent/eval-checks";
import type { CaseCheck, Expectation, TraceLine } from "../src/agent/eval-checks";
import type { RunResult } from "../src/agent/orchestrator";
import { promptVersion } from "../src/agent/prompts";
import { CASE_CHAINS, chainGroups, chainsFirst, runChains } from "./case-chains";

type RedTeamCase = { id: string; data_dir?: string; input: Record<string, unknown>; expect: Expectation };

/** One case in the usual order. `skipped` is an expectation whose input file does not exist yet. */
export type EvalCase = { id: string; body: unknown; exp: Expectation | undefined; dataDir: string | undefined; skipped: boolean };
/** One case as a run: the absolute data dir it runs on and, for a fixture, why every query runs locally. */
export type RunJob = { id: string; body: unknown; dataDir: string; localReason?: string };
export type Outcome = { result: RunResult; seconds: number };
export type Row = { id: string; verdict: "pass" | "fail" | "skipped" | "rate-limited"; result: RunResult | null; failed: CaseCheck[]; seconds: number };
export type Checks = Pick<typeof EvalChecks, "checkExpectation" | "universalChecks" | "tracePathChecks">;
/** Runs one group's cases in order and calls `report` once per case as it finishes. */
export type RunGroup = (group: EvalCase[], index: number, report: (id: string, outcome: Outcome) => void) => Promise<void>;

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Every input_examples/*.json in name order, then each expectation with no input file (skipped), then every red-team case. */
export function listCases(root: string): EvalCase[] {
  const inputs = path.join(root, "input_examples");
  const expectations = readJson<Record<string, Expectation>>(path.join(root, "evals", "expectations.json"));
  const redteam = readJson<RedTeamCase[]>(path.join(root, "evals", "redteam", "cases.json"));
  const files = readdirSync(inputs).filter((name) => name.endsWith(".json")).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const id = path.basename(file, ".json");
    const body = readJson<Record<string, unknown>>(path.join(inputs, file));
    cases.push({ id, body: { ...body, run_id: id }, exp: expectations[id], dataDir: undefined, skipped: false });
  }
  for (const id of Object.keys(expectations)) {
    if (!files.includes(`${id}.json`)) cases.push({ id, body: null, exp: expectations[id], dataDir: undefined, skipped: true });
  }
  for (const item of redteam) {
    cases.push({ id: item.id, body: { run_id: item.id, input: item.input }, exp: item.expect, dataDir: item.data_dir, skipped: false });
  }
  return cases;
}

/** The run for a case: its own fixture (every query local) or `baseDir`. */
export function jobFor(item: EvalCase, root: string, baseDir: string): RunJob {
  if (item.dataDir === undefined) return { id: item.id, body: item.body, dataDir: baseDir };
  return { id: item.id, body: item.body, dataDir: path.resolve(root, item.dataDir), localReason: `eval fixture ${item.dataDir} is not in Postgres: every query runs locally` };
}

/** Runs one case in this process on its data dir. TRADEFLOW_DATA_DIR is process-wide, so one case at a time per process. */
export async function runCaseHere(job: RunJob): Promise<Outcome> {
  process.env.TRADEFLOW_DATA_DIR = job.dataDir;
  const { runRequest } = await import("../src/agent/request");
  const started = Date.now();
  const result = await runRequest(job.body, job.localReason === undefined ? {} : { localReason: job.localReason });
  return { result, seconds: (Date.now() - started) / 1000 };
}

export function traceOf(runId: string, root: string = process.cwd()): TraceLine[] {
  const file = path.join(root, "logs", `trace-${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceLine);
}

/** A finished case as a row: rate-limited, or pass or fail on its expectation, the universal checks and its trace path. */
export function rowFor(item: EvalCase, outcome: Outcome, real: boolean, checks: Checks): Row {
  const { result, seconds } = outcome;
  if (result.status === "error" && result.error?.type === "RateLimited") return { id: item.id, verdict: "rate-limited", result, failed: [], seconds };
  const trace = traceOf(item.id);
  const all = [...(item.exp === undefined ? [] : checks.checkExpectation(result, item.exp, real, trace)), ...checks.universalChecks(result, trace), ...checks.tracePathChecks(item.id, result, trace)];
  const failed = all.filter((c) => !c.pass);
  return { id: item.id, verdict: failed.length === 0 ? "pass" : "fail", result, failed, seconds };
}

/** A group whose runner rejected: its case ids and the reason. */
export type GroupError = { ids: string[]; reason: string };

/**
 * Runs every case that is not skipped and returns one row per case in the usual order, and every group that
 * rejected. With concurrency 1 every case is one group, in order. Above 1 the cases are split by chainGroups, chains
 * first (chainsFirst), and at most `concurrency` groups run at once through runChains. A case with no row once every
 * group has settled, from a rejected group or one that resolved without reporting it, gets a fail row that says why.
 * `onRow` sees each row as its case finishes.
 */
export async function evaluate(
  cases: EvalCase[],
  options: { concurrency: number; real: boolean; checks: Checks; runGroup: RunGroup; onRow?: (row: Row) => void; chains?: ReadonlyArray<readonly string[]> },
): Promise<{ rows: Row[]; errors: GroupError[] }> {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const runnable = cases.filter((item) => !item.skipped).map((item) => item.id);
  const groups = options.concurrency <= 1 ? [runnable] : chainsFirst(chainGroups(runnable, options.chains ?? CASE_CHAINS));
  const rows = new Map<string, Row>();
  const settled = await runChains(
    groups,
    (ids, index) =>
      options.runGroup(
        ids.map((id) => byId.get(id) as EvalCase),
        index,
        (id, outcome) => {
          const row = rowFor(byId.get(id) as EvalCase, outcome, options.real, options.checks);
          rows.set(id, row);
          options.onRow?.(row);
        },
      ),
    options.concurrency,
  );
  const errors: GroupError[] = [];
  settled.forEach((outcome, index) => {
    const reason = outcome.status === "rejected" ? (outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)) : null;
    if (reason !== null) errors.push({ ids: groups[index], reason });
    for (const id of groups[index]) {
      if (rows.has(id)) continue;
      const detail = reason ?? "no result: its group finished without running it";
      const row: Row = { id, verdict: "fail", result: null, failed: [{ name: "run", pass: false, detail }], seconds: 0 };
      rows.set(id, row);
      options.onRow?.(row);
    }
  });
  return { rows: cases.map((item) => (item.skipped ? { id: item.id, verdict: "skipped", result: null, failed: [], seconds: 0 } : (rows.get(item.id) as Row))), errors };
}

/**
 * The eval's exit code: 1 when any row failed (a check, a group that stopped, or a case with no result) or any group
 * stopped, even one that reported every case first; else 0. Skipped and rate-limited rows do not fail it. Pure.
 */
export function evalExitCode(rows: readonly Row[], errors: readonly GroupError[]): 0 | 1 {
  return rows.some((row) => row.verdict === "fail") || errors.length > 0 ? 1 : 0;
}

/** The Evaluator total, or "score unavailable" when the Evaluator accepted the draft unscored; never 0 for a missing score. */
function totalCell(row: Row): string {
  const total = row.result?.output?.scores?.total;
  if (typeof total === "number") return String(total);
  if (row.result === null) return "-";
  return traceOf(row.id).some((line) => line.agent_name === "Evaluator" && line.action === "score_unavailable") ? "score unavailable" : "-";
}

const cell = (value: unknown): string => (value === null || value === undefined ? "-" : String(value).replace(/\|/g, "/"));

export function tableLines(rows: Row[]): string[] {
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

/**
 * `meta.concurrency` above 1 adds a "Concurrency" line to a real-model section; the sample section never has one.
 * `meta.failedGroups` adds a "Failed groups" line to any section, so a group that stopped after reporting every case
 * still shows.
 */
export function writeResults(file: string, rows: Row[], real: boolean, meta: { commit: string; models: { strong?: string; main?: string; fast?: string }; host: string; concurrency?: number; failedGroups?: readonly GroupError[] }): void {
  const date = new Date().toISOString().slice(0, 10);
  const { routed, cost } = modelStats(rows.filter((row) => row.result !== null).map((row) => row.id));
  const totals = { pass: rows.filter((r) => r.verdict === "pass").length, fail: rows.filter((r) => r.verdict === "fail").length, skipped: rows.filter((r) => r.verdict === "skipped").length, limited: rows.filter((r) => r.verdict === "rate-limited").length };
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "# Eval results\n\nWritten by `npm run eval`. Each row is one input example or red-team case; see `scripts/eval.ts` for the checks.\n";
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
    ...(real && (meta.concurrency ?? 1) > 1 ? [`- Concurrency: ${meta.concurrency}`] : []),
    ...((meta.failedGroups ?? []).length > 0 ? [`- Failed groups: ${(meta.failedGroups ?? []).map((group) => `${group.ids.join(", ")} (${group.reason.replace(/\|/g, "/")})`).join("; ")}`] : []),
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
  writeFileSync(file, `${next.trimEnd()}\n`);
}
