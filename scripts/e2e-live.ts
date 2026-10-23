// npm run e2e:live -- --out <dir> [--concurrency N] [--base http://localhost:8000] [--redteam] [--only id1,id2 [--no-chain-deps]]
// Runs every input_examples/*.json (or, with --redteam, every case in evals/redteam/cases.json) against the running
// app, or with --only just the named cases, each with the cases its chain runs before it unless --no-chain-deps
// (selectCases in scripts/case-chains.ts; an unknown id is an error): POST <base>/run per case, chains in order (scripts/case-chains.ts), at most N cases at once. A 429 Busy is
// retried after Retry-After. Each reply goes to <dir>/<case>.json and its trace (GET <base>/run/<run_id>) to
// <dir>/<case>.trace.jsonl, and one line per case is printed: case, HTTP status, status, stop_reason, seconds, model
// calls. A red-team case with a data_dir runs through npm run agent on a copy of its fixture instead. It never edits
// the repo: the app writes its own logs/, and the runner writes only under <dir>. It checks nothing against the
// expectations in full; npm run eval does that. Chains start first. Each case is a result (success or needs_human),
// an expected error (the error_type its expectation names with status "error"), an unexpected error (any other reply,
// such as a 500 Timeout) or no result (no reply, still 429 Busy after the whole wait, or not run). A case that is
// not a result or an expected error stops the rest of its chain. Each line also names the memory the run recalled.
// After the run it prints every case again in case order. It exits 1 on any unexpected error, no result, missing
// case or stopped group (liveExitCode in scripts/live-runner.ts). Ctrl-C stops its npm run agent children and removes
// its temporary dirs. Loads .env through node --env-file for the limits; it never opens it. Runs under tsx as
// CommonJS: async main(), no top-level await.
import path from "node:path";
import { loadConfig, type Config } from "../src/agent/config";
import { chainGroups, chainsFirst, parseConcurrency, parseOnly, runChains, selectCases } from "./case-chains";
import { caseKind, counts, ensureDir, liveCases, liveExitCode, runCliCase, runHttpCase, runLiveGroup, stopLiveRuns, summaryLine, type LiveCase, type LiveOutcome } from "./live-runner";

const ROOT = process.cwd();
const USAGE = "Usage: npm run e2e:live -- --out <dir> [--concurrency N] [--base http://localhost:8000] [--redteam] [--only id1,id2 [--no-chain-deps]]";

type Args = { concurrency: number; base: string; out: string; redteam: boolean; only: string[] | null; chainDeps: boolean };

function parseArgs(argv: string[]): Args | string {
  const parsed = parseConcurrency(argv, undefined);
  if (parsed.error !== null) return parsed.error;
  let base = "http://localhost:8000";
  let out: string | null = null;
  let redteam = false;
  let only: string[] | null = null;
  let chainDeps = true;
  const rest = parsed.rest;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === "--redteam") redteam = true;
    else if (arg === "--no-chain-deps") chainDeps = false;
    else if (arg === "--only" || arg.startsWith("--only=")) {
      const listed = parseOnly(arg === "--only" ? value : arg.slice("--only=".length));
      if (listed.error !== null) return listed.error;
      only = listed.ids;
      if (arg === "--only") i += 1;
    }
    else if (arg === "--base" || arg === "--out") {
      if (value === undefined || value.startsWith("--")) return `${arg} needs a value.`;
      if (arg === "--base") base = value;
      else out = value;
      i += 1;
    } else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else return `Unknown option ${arg}.`;
  }
  if (out === null || out === "") return "--out <dir> is required: the runner saves each reply and trace there.";
  try {
    new URL(base);
  } catch {
    return `--base must be a URL such as http://localhost:8000, got ${JSON.stringify(base)}.`;
  }
  if (!chainDeps && only === null) return "--no-chain-deps needs --only.";
  return { concurrency: parsed.concurrency, base, out: path.resolve(ROOT, out), redteam, only, chainDeps };
}

function limits(): Config {
  try {
    return loadConfig(process.env, () => {});
  } catch {
    return loadConfig({}, () => {});
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return 2;
  }
  const config = limits();
  // The longest a run may take on the server, plus a minute for the reply to arrive.
  const timeoutMs = Math.max(config.RUN_TIMEOUT_MS, config.BRIEFING_TIMEOUT_MS) + 60_000;
  if (args.concurrency > config.MAX_CONCURRENT_RUNS) {
    process.stdout.write(
      `Note: --concurrency ${args.concurrency} is above MAX_CONCURRENT_RUNS ${config.MAX_CONCURRENT_RUNS} (as this shell and .env set it; the server reads its own). ` +
        `Beyond its cap the server answers 429 Busy and the runner waits and tries again, so the extra cases queue. ` +
        `To run ${args.concurrency} at once, start the server with MAX_CONCURRENT_RUNS=${args.concurrency} npm run dev -- -p 8000.\n`,
    );
  }
  const allCases = liveCases(ROOT, args.redteam);
  let cases = allCases;
  if (args.only !== null) {
    const selected = selectCases(
      allCases.map((item) => item.id),
      args.only,
      args.chainDeps,
    );
    if (selected.error !== null) {
      process.stderr.write(`${selected.error}\n${USAGE}\n`);
      return 2;
    }
    const keep = new Set(selected.ids);
    cases = allCases.filter((item) => keep.has(item.id));
    const added = selected.ids.filter((id) => !args.only?.includes(id));
    if (added.length > 0) process.stdout.write(`--only ${args.only.join(",")}: also running ${added.join(", ")}, which their chain runs first (--no-chain-deps to skip them).\n`);
  }
  ensureDir(args.out);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const groups = chainsFirst(chainGroups(cases.map((item) => item.id)));
  const chains = groups.filter((group) => group.length > 1).map((group) => group.join(" -> "));
  process.stdout.write(`${cases.length} cases against ${args.base}, ${args.concurrency} at a time; chains first and in order: ${chains.join("; ") || "none"}. Each run may take up to ${Math.round(timeoutMs / 60_000)} min.\n`);

  // On Ctrl-C or a kill, stop the npm run agent children and remove the temp dirs this runner made, then exit.
  const stop = (signal: NodeJS.Signals): void => {
    const stopped = stopLiveRuns(signal);
    process.stderr.write(`\nStopped by ${signal}: ${stopped.children} agent runs stopped, ${stopped.dirs} temporary dirs removed. Runs already posted to the server keep running there.\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const started = Date.now();
  const outcomes = new Map<string, LiveOutcome>();
  const kindOf = (outcome: LiveOutcome) => caseKind(byId.get(outcome.id), outcome);
  let busySeen = false;
  const settled = await runChains(
    groups,
    (group) =>
      runLiveGroup(
        group,
        (id) => {
          const item = byId.get(id) as LiveCase;
          return item.dataDir === undefined
            ? runHttpCase(item, args.base, args.out, timeoutMs, {
                onBusy: (caseId, ms) => {
                  if (!busySeen) process.stdout.write(`${caseId}: the server is at its MAX_CONCURRENT_RUNS cap (429 Busy); waiting ${ms / 1000} s and trying again.\n`);
                  busySeen = true;
                },
              })
            : runCliCase(item, ROOT, args.out, timeoutMs);
        },
        (outcome) => {
          outcomes.set(outcome.id, outcome);
          process.stdout.write(`${summaryLine(outcome, kindOf(outcome))}\n`);
        },
        (outcome) => counts(kindOf(outcome)),
      ),
    args.concurrency,
  );
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);

  const tally = liveExitCode(cases, outcomes, groups, settled);
  const ordered = cases.map((item) => outcomes.get(item.id)).filter((outcome): outcome is LiveOutcome => outcome !== undefined);
  process.stdout.write(`\nIn case order:\n${ordered.map((outcome) => summaryLine(outcome, kindOf(outcome))).join("\n")}\n\n`);
  for (const group of tally.rejected) process.stdout.write(`The group ${group.ids.join(", ")} stopped: ${group.reason}\n`);
  if (tally.missing.length > 0) process.stdout.write(`No outcome for: ${tally.missing.join(", ")}\n`);
  if (tally.byKind["unexpected error"].length > 0) process.stdout.write(`Unexpected errors: ${tally.byKind["unexpected error"].join(", ")}\n`);
  if (tally.byKind["no result"].length > 0) process.stdout.write(`No result or not run: ${tally.byKind["no result"].join(", ")}\n`);
  process.stdout.write(
    `${cases.length} cases in ${((Date.now() - started) / 60_000).toFixed(1)} min: ${tally.byKind.result.length} results, ${tally.byKind["expected error"].length} expected errors, ` +
      `${tally.byKind["unexpected error"].length} unexpected errors, ${tally.byKind["no result"].length} no result or not run, ${tally.missing.length} missing. Exit ${tally.code}. Saved to ${args.out}\n`,
  );
  return tally.code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
