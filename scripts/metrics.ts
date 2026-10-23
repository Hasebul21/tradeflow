// npm run metrics [-- --json] [-- --limit <n>]: the numbers of GET /metrics for the newest runs in logs/ (200 by
// default, at most 1000), as a text table with one row per task, all runs first, then the prompt versions. --json
// prints the same JSON GET /metrics returns. Reads only logs/trace-*.jsonl. Loads .env through node --env-file; it
// never opens it. Runs under tsx as CommonJS: async main(), no top-level await.
import { ALL_RUNS, metricsFromTraces, metricsPayload, promptVersionRows, readRuns, runLimit, type TaskMetrics } from "../src/agent/metrics";

type Parsed = { json: boolean; limit: number; error: string | null };

function parseArgs(argv: string[]): Parsed {
  let json = false;
  let limit = runLimit(undefined);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg === "--limit" ? argv[(i += 1)] : arg.slice("--limit=".length);
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) return { json, limit, error: "--limit needs a whole number of 1 or more." };
      limit = runLimit(value);
    } else return { json, limit, error: `Unknown option ${arg}.` };
  }
  return { json, limit, error: null };
}

const s = (ms: number) => `${(ms / 1000).toFixed(1)}`;
const avg = (n: number) => (Math.round(n * 10) / 10).toString();

function row(task: string, m: TaskMetrics): string[] {
  const rounds = Object.entries(m.rounds).map(([n, count]) => `${n}:${count}`).join(" ");
  return [
    task,
    String(m.runs),
    String(m.by_status.success),
    String(m.by_status.needs_human),
    String(m.by_status.error),
    String(m.by_status.unknown),
    `${Math.round(m.rejection_rate * 100)}%`,
    rounds,
    avg(m.avg_model_calls),
    avg(m.avg_query_calls),
    String(Math.round(m.avg_tokens)),
    s(m.duration_ms.p50),
    s(m.duration_ms.p95),
    `${m.queries.zetaris}/${m.queries.local}/${m.queries.local_fallback}`,
    `${m.guards.checked}/${m.guards.blocked}/${m.guards.injections_flagged}/${m.guards.advice_declined}`,
    String(m.strong_to_main_fallbacks),
    `${m.memories.recalled}/${m.memories.by_tag}`,
  ];
}

const HEADER = ["task", "runs", "success", "needs_human", "error", "unknown", "rejected", "rounds", "model calls", "query calls", "tokens", "p50 s", "p95 s", "queries z/l/lf", "guards c/b/i/a", "strong>main", "memories r/tag"];

function table(rows: string[][]): string {
  const widths = HEADER.map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows.map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd()).join("\n");
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error !== null) {
    process.stderr.write(`${parsed.error}\nUsage: npm run metrics [-- --json] [-- --limit <n>]\n`);
    return 2;
  }
  const runs = await readRuns("logs", parsed.limit);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(metricsPayload(runs), null, 2)}\n`);
    return 0;
  }
  const metrics = metricsFromTraces(runs);
  const tasks = [ALL_RUNS, ...Object.keys(metrics).filter((key) => key !== ALL_RUNS)];
  process.stdout.write(`From the newest ${runs.length} runs in logs/\n\n`);
  process.stdout.write(`${table([HEADER, ...tasks.map((task) => row(task, metrics[task]))])}\n`);
  const versions = promptVersionRows(metrics[ALL_RUNS]);
  if (versions.length > 0) {
    process.stdout.write(`\nPrompt versions (agent, hash, runs)\n${versions.map((v) => `${v.agent.padEnd(10)} ${v.prompt_hash}  ${v.runs}`).join("\n")}\n`);
  }
  return 0;
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
