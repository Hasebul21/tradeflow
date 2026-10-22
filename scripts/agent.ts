// CLI: npm run agent -- <input.json> [more.json ...] [--out <dir>]
// Reads each file (the same body POST /run takes), runs them in order in this process so memory carries over, prints
// each result as JSON, then the summary and review_markdown of a result that has a review. With --out <dir> it also
// writes each result to <dir>/<input file name>.json. No interactive input. Loads .env through node --env-file; it
// never opens it. Runs under tsx as CommonJS: async main(), no top-level await.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runRequest } from "../src/agent/request";
import type { RunResult } from "../src/agent/orchestrator";

type Parsed = { files: string[]; out: string | null; error: string | null };

function parseArgs(argv: string[]): Parsed {
  const files: string[] = [];
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { files, out, error: "--out needs a directory." };
      out = value;
      i += 1;
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("--")) {
      return { files, out, error: `Unknown option ${arg}.` };
    } else {
      files.push(arg);
    }
  }
  return { files, out, error: files.length === 0 ? "Pass at least one input file." : null };
}

function inputError(runId: string, message: string): RunResult {
  const usage = { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 };
  return { run_id: runId, task: "explain_week", status: "error", output: null, error: { type: "InvalidInput", message, recoverable: false }, agents: [], usage, trace_id: runId, log_file: null, execution_time_seconds: 0 };
}

async function runFile(file: string): Promise<RunResult> {
  let body: unknown;
  try {
    body = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return inputError("", `Could not read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return runRequest(body);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.error !== null) {
    process.stderr.write(`${args.error}\nUsage: npm run agent -- <input.json> [more.json ...] [--out <dir>]\n`);
    return 2;
  }
  if (args.out !== null) await mkdir(args.out, { recursive: true });
  let failed = 0;
  for (const file of args.files) {
    const result = await runFile(file);
    if (result.status === "error") failed += 1;
    const json = JSON.stringify(result, null, 2);
    process.stdout.write(`${json}\n`);
    if (result.output !== null) {
      process.stdout.write(`\n${result.output.summary}\n\n${result.output.review_markdown}\n\n`);
    }
    if (args.out !== null) await writeFile(path.join(args.out, `${path.basename(file, path.extname(file))}.json`), `${json}\n`);
  }
  return failed > 0 ? 1 : 0;
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
