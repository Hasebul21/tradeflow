// npm run eval [-- --no-results] [--concurrency N]: runs every input_examples/*.json in name order, then every case in
// evals/redteam/cases.json, and checks each result against evals/expectations.json or the case's expect block (no_query
// reads the run's trace), the checks every result gets, and the trace path of its task. Prints a table and exits 1 on
// any failure. A plain run writes evals/RESULTS.md: a sample-mode run replaces its "Sample mode" section, a real-model
// run appends a "Real model, run <n>" section. --no-results (npm run check) writes nothing.
//
// Concurrency: --concurrency N (or EVAL_CONCURRENCY), default 1. With 1, every case runs in this process, one after
// the other, on one shared data dir, as before. Above 1, the cases are split into chains (scripts/case-chains.ts):
// a chain's cases run in order, and up to N chains or lone cases run at once, each group in its own child process
// (scripts/eval-worker.ts) on its own temporary copy of its data dir, so memory never leaks between groups. The
// table and RESULTS.md list the cases in the usual order either way.
//
// Mode: sample unless the shell sets SAMPLE_MODE=false (--env-file never overrides a shell value, and .env leaves
// SAMPLE_MODE empty). SAMPLE_MODE=true wins over each input's options.sample_mode, as in POST /run. Data: every run
// uses a fixture data dir from make-fixtures.ts (base unless the case names one), so memory starts empty each eval
// run and data/ is never touched. Loads .env through node --env-file; it never opens it. Runs under tsx as
// CommonJS: async main(), no top-level await.
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chainGroups, chainsFirst, parseConcurrency } from "./case-chains";
import { evalExitCode, evaluate, jobFor, listCases, runCaseHere, tableLines, writeResults, type EvalCase, type Outcome, type RunGroup } from "./eval-cases";
import { FIXTURES_DIR, makeFixtures } from "./make-fixtures";

const ROOT = process.cwd();
const RESULTS = path.join(ROOT, "evals", "RESULTS.md");
const BASE_DIR = path.join(FIXTURES_DIR, "base");
const WORKER = path.join(__dirname, "eval-worker.ts");
const USAGE = "Usage: npm run eval [-- --no-results] [--concurrency N]";
/** The running eval workers, so a SIGINT or SIGTERM can stop them. */
const workers = new Set<ChildProcess>();

function shortCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Every case of the group in this process, in order, on the shared data dirs: the behaviour of concurrency 1. */
const runHere: RunGroup = async (group, _index, report) => {
  for (const item of group) report(item.id, await runCaseHere(jobFor(item, ROOT, BASE_DIR)));
};

/**
 * A runner that gives each group its own copy of every data dir it uses, under `tmp`, and runs the group in a child
 * process (scripts/eval-worker.ts) with the same node flags and environment as this one.
 */
function inWorkers(tmp: string): RunGroup {
  return (group, index, report) => {
    const groupDir = path.join(tmp, String(index));
    const copies = new Map<string, string>();
    const jobs = group.map((item) => {
      const job = jobFor(item, ROOT, BASE_DIR);
      let copy = copies.get(job.dataDir);
      if (copy === undefined) {
        copy = path.join(groupDir, `${copies.size}-${path.basename(job.dataDir)}`);
        mkdirSync(groupDir, { recursive: true });
        cpSync(job.dataDir, copy, { recursive: true });
        copies.set(job.dataDir, copy);
      }
      return { ...job, dataDir: copy };
    });
    return new Promise<void>((resolve, reject) => {
      const child = fork(WORKER, [], { cwd: ROOT, env: process.env, execArgv: process.execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      workers.add(child);
      child.on("message", (message: { id: string } & Outcome) => report(message.id, { result: message.result, seconds: message.seconds }));
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        workers.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`the eval worker for ${group.map((item) => item.id).join(", ")} stopped (${signal ?? `exit code ${code}`})`));
      });
      child.send({ jobs });
    });
  };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseConcurrency(argv, process.env.EVAL_CONCURRENCY);
  if (parsed.error !== null) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const noResults = parsed.rest.includes("--no-results");
  const unknown = parsed.rest.filter((arg) => arg !== "--no-results");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option ${unknown.join(" ")}.\n${USAGE}\n`);
    return 2;
  }
  const { concurrency } = parsed;
  const commit = shortCommit();
  makeFixtures();
  const real = (process.env.SAMPLE_MODE ?? "").trim().toLowerCase() === "false";
  if (!real) process.env.SAMPLE_MODE = "true";
  process.env.TRADEFLOW_DATA_DIR = BASE_DIR;

  const { loadConfig } = await import("../src/agent/config");
  const checks = await import("../src/agent/eval-checks");
  const cases: EvalCase[] = listCases(ROOT);

  let tmp: string | null = null;
  // On Ctrl-C or a kill, stop every worker and remove the temporary data dirs before exiting.
  const stop = (signal: NodeJS.Signals): void => {
    for (const child of workers) child.kill(signal);
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(`\nStopped by ${signal}: ${workers.size} eval workers stopped, temporary data dirs removed.\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (concurrency > 1) {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-eval-"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const groups = chainsFirst(chainGroups(cases.filter((item) => !item.skipped).map((item) => item.id)));
    const chains = groups.filter((group) => group.length > 1).map((group) => group.join(" -> "));
    process.stdout.write(`Running ${groups.length} groups, ${concurrency} at a time, each on its own copy of its data dir. Chains first and in order: ${chains.join("; ") || "none"}.\n`);
  }
  let rows;
  let errors;
  try {
    ({ rows, errors } = await evaluate(cases, {
      concurrency,
      real,
      checks,
      runGroup: tmp === null ? runHere : inWorkers(tmp),
      onRow: (row) => {
        if (row.verdict !== "pass" && row.verdict !== "fail") return;
        const failed = row.failed.map((c) => `${c.name}: ${c.detail}`).join("; ");
        process.stdout.write(`${row.verdict === "pass" ? "pass" : "FAIL"} ${row.id}: ${row.result?.status ?? "no result"}${failed === "" ? "" : ` (${failed})`}\n`);
      },
    }));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`\n${tableLines(rows).join("\n")}\n`);
  const fails = rows.filter((row) => row.verdict === "fail").length;
  const passes = rows.filter((row) => row.verdict === "pass").length;
  const skipped = rows.filter((row) => row.verdict === "skipped").length;
  const limited = rows.filter((row) => row.verdict === "rate-limited").length;
  process.stdout.write(`\n${passes} passed, ${fails} failed, ${skipped} skipped${limited > 0 ? `, ${limited} rate-limited` : ""} (${real ? "real model" : "sample mode"})\n`);
  for (const error of errors) process.stdout.write(`Group ${error.ids.join(", ")} stopped: ${error.reason}\n`);

  if (!noResults) {
    const config = loadConfig(process.env, () => {});
    let host = "unknown";
    try {
      host = new URL(process.env.METERLESS_BASE_URL ?? "").hostname || "unknown";
    } catch {
      host = "unknown";
    }
    writeResults(RESULTS, rows, real, { commit, models: config.models, host, concurrency, failedGroups: errors });
    process.stdout.write(`wrote ${path.relative(ROOT, RESULTS)}\n`);
  }
  return evalExitCode(rows, errors);
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
