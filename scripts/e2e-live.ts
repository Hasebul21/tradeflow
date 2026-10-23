// npm run e2e:live -- --out <dir> [--concurrency N] [--base http://localhost:8000] [--redteam]
// Runs every input_examples/*.json (or, with --redteam, every case in evals/redteam/cases.json) against the running
// app: POST <base>/run per case, chains in order (scripts/case-chains.ts), at most N cases at once. A 429 Busy is
// retried after Retry-After. Each reply goes to <dir>/<case>.json and its trace (GET <base>/run/<run_id>) to
// <dir>/<case>.trace.jsonl, and one line per case is printed: case, HTTP status, status, stop_reason, seconds, model
// calls. A red-team case with a data_dir runs through npm run agent on a copy of its fixture instead. It never edits
// the repo: the app writes its own logs/, and the runner writes only under <dir>. It checks nothing against the
// expectations; npm run eval does that. Chains start first. A case with no result (no reply, or still 429 Busy after
// the whole wait) stops the rest of its chain, which is marked not run. Each line also names the memory the run
// recalled. After the run it prints every case again in case order. It exits 1 when a case has no result or was not
// run, or a group stopped; an error reply is a result, because some red-team cases expect one. Loads .env through node --env-file for the limits; it never opens it. Runs
// under tsx as CommonJS: async main(), no top-level await.
import path from "node:path";
import { loadConfig, type Config } from "../src/agent/config";
import { chainGroups, chainsFirst, parseConcurrency, runChains } from "./case-chains";
import { ensureDir, liveCases, runCliCase, runHttpCase, runLiveGroup, summaryLine, type LiveCase, type LiveOutcome } from "./live-runner";

const ROOT = process.cwd();
const USAGE = "Usage: npm run e2e:live -- --out <dir> [--concurrency N] [--base http://localhost:8000] [--redteam]";

type Args = { concurrency: number; base: string; out: string; redteam: boolean };

function parseArgs(argv: string[]): Args | string {
  const parsed = parseConcurrency(argv, undefined);
  if (parsed.error !== null) return parsed.error;
  let base = "http://localhost:8000";
  let out: string | null = null;
  let redteam = false;
  const rest = parsed.rest;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === "--redteam") redteam = true;
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
  return { concurrency: parsed.concurrency, base, out: path.resolve(ROOT, out), redteam };
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
  ensureDir(args.out);
  const cases = liveCases(ROOT, args.redteam);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const groups = chainsFirst(chainGroups(cases.map((item) => item.id)));
  const chains = groups.filter((group) => group.length > 1).map((group) => group.join(" -> "));
  process.stdout.write(`${cases.length} cases against ${args.base}, ${args.concurrency} at a time; chains first and in order: ${chains.join("; ") || "none"}. Each run may take up to ${Math.round(timeoutMs / 60_000)} min.\n`);

  const started = Date.now();
  const outcomes = new Map<string, LiveOutcome>();
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
          process.stdout.write(`${summaryLine(outcome)}\n`);
        },
      ),
    args.concurrency,
  );

  settled.forEach((result, index) => {
    if (result.status === "rejected") process.stdout.write(`The group ${groups[index].join(", ")} stopped: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
  });
  const missing = cases.filter((item) => !outcomes.has(item.id)).map((item) => item.id);
  const rejected = settled.filter((result) => result.status === "rejected").length;
  const ordered = cases.map((item) => outcomes.get(item.id)).filter((outcome): outcome is LiveOutcome => outcome !== undefined);
  // An error reply is a result (some red-team cases expect InvalidInput); a case with no reply, a case not run and a
  // stopped group fail the run.
  const noReply = ordered.filter((outcome) => outcome.reply === null).length;
  const errors = ordered.filter((outcome) => outcome.reply?.status === "error").length;
  process.stdout.write(`\nIn case order:\n${ordered.map(summaryLine).join("\n")}\n`);
  if (missing.length > 0) process.stdout.write(`No outcome for: ${missing.join(", ")}\n`);
  process.stdout.write(`\n${cases.length} cases in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${errors} error replies, ${noReply} with no reply or not run, ${missing.length} missing. Saved to ${args.out}\n`);
  return noReply > 0 || missing.length > 0 || rejected > 0 ? 1 : 0;
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
