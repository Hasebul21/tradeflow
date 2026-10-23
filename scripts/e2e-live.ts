// npm run e2e:live -- --out <dir> [--concurrency N] [--base http://localhost:8000] [--redteam]
// Runs every input_examples/*.json (or, with --redteam, every case in evals/redteam/cases.json) against the running
// app: POST <base>/run per case, chains in order (scripts/case-chains.ts), at most N cases at once. A 429 Busy is
// retried after Retry-After. Each reply goes to <dir>/<case>.json and its trace (GET <base>/run/<run_id>) to
// <dir>/<case>.trace.jsonl, and one line per case is printed: case, HTTP status, status, stop_reason, seconds, model
// calls. A red-team case with a data_dir runs through npm run agent on a copy of its fixture instead. It never edits
// the repo: the app writes its own logs/, and the runner writes only under <dir>. It checks nothing against the
// expectations; npm run eval does that. It exits 1 only when a case got no reply at all. Loads .env through node --env-file for the limits; it never opens it. Runs
// under tsx as CommonJS: async main(), no top-level await.
import path from "node:path";
import { loadConfig, type Config } from "../src/agent/config";
import { chainGroups, parseConcurrency, runChains } from "./case-chains";
import { ensureDir, liveCases, runCliCase, runHttpCase, summaryLine, type LiveOutcome } from "./live-runner";

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
  const groups = chainGroups(cases.map((item) => item.id));
  const chains = groups.filter((group) => group.length > 1).map((group) => group.join(" -> "));
  process.stdout.write(`${cases.length} cases against ${args.base}, ${args.concurrency} at a time; chains in order: ${chains.join("; ") || "none"}. Each run may take up to ${Math.round(timeoutMs / 60_000)} min.\n`);

  const started = Date.now();
  const outcomes: LiveOutcome[] = [];
  let busySeen = false;
  await runChains(
    groups,
    async (group) => {
      for (const id of group) {
        const item = byId.get(id);
        if (item === undefined) continue;
        const outcome =
          item.dataDir === undefined
            ? await runHttpCase(item, args.base, args.out, timeoutMs, {
                onBusy: (caseId, ms) => {
                  if (!busySeen) process.stdout.write(`${caseId}: the server is at its MAX_CONCURRENT_RUNS cap (429 Busy); waiting ${ms / 1000} s and trying again.\n`);
                  busySeen = true;
                },
              })
            : await runCliCase(item, ROOT, args.out, timeoutMs);
        outcomes.push(outcome);
        process.stdout.write(`${summaryLine(outcome)}\n`);
      }
    },
    args.concurrency,
  );

  // An error reply is a result (some red-team cases expect InvalidInput); only a case with no reply fails the run.
  const noReply = outcomes.filter((outcome) => outcome.reply === null).length;
  const errors = outcomes.filter((outcome) => outcome.reply?.status === "error").length;
  process.stdout.write(`\n${outcomes.length} cases in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${errors} error replies, ${noReply} with no reply. Saved to ${args.out}\n`);
  return noReply > 0 ? 1 : 0;
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
