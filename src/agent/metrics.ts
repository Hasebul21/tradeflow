// Metrics across runs, read from the trace files and nothing else. readRuns lists logs/trace-*.jsonl; metricsFromTraces
// is pure: it counts what the lines say (the run_end line for status, stop_reason and usage; proofFromTrace for
// queries, memories, models and guards, so the numbers agree with the Proof cards) and invents no number.
// Server only (node:fs).
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { proofFromTrace } from "./proof";
import type { TraceLine } from "./trace";
import { parseTrace, summarise, TRACE_FILE } from "./trace-read";

/** One run: the lines of its trace file, in file order. */
export type RunLines = readonly TraceLine[];

export const DEFAULT_RUN_LIMIT = 200;
export const MAX_RUN_LIMIT = 1000;

/** The task of a run whose lines carry none: an older trace. */
export const UNKNOWN_TASK = "unknown";
/** The key of the group that holds every run. */
export const ALL_RUNS = "all";

export type PromptVersionCount = { prompt_hash: string; runs: number };

export type TaskMetrics = {
  runs: number;
  by_status: { success: number; needs_human: number; error: number; unknown: number };
  by_stop_reason: Record<string, number>;
  /** Runs by their rounds (the highest retry_count plus 1); 1, 2 and 3 are always there, a run with more rounds adds its own key. */
  rounds: Record<string, number>;
  /** The share of runs with at least one Evaluator line with action "reject". */
  rejection_rate: number;
  /** The averages are over the runs that have a run_end line, the only line that holds a run's total usage. */
  avg_model_calls: number;
  avg_query_calls: number;
  avg_tokens: number;
  /** Nearest-rank percentiles of the run_end lines' duration_ms. */
  duration_ms: { p50: number; p95: number };
  queries: { zetaris: number; local: number; local_fallback: number };
  guards: { checked: number; blocked: number; injections_flagged: number; advice_declined: number };
  strong_to_main_fallbacks: number;
  memories: { recalled: number; by_tag: number };
  /** Per agent: each prompt hash seen on its model lines and the number of runs that used it. */
  prompt_versions: Record<string, PromptVersionCount[]>;
};

/** "all" first, then each task found, in the order its first run appears. */
export type Metrics = Record<string, TaskMetrics>;

/** logs/trace-*.jsonl in `dir`, newest first by modification time, at most `limit` runs. Any other file or path is never opened. */
export async function readRuns(dir: string, limit: number = DEFAULT_RUN_LIMIT): Promise<RunLines[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && TRACE_FILE.test(entry.name))
      .map(async (entry) => {
        try {
          return { name: entry.name, mtime: (await stat(path.join(dir, entry.name))).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const newestFirst = files
    .filter((file): file is { name: string; mtime: number } => file !== null)
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  const runs: RunLines[] = [];
  for (const file of newestFirst) {
    if (runs.length >= limit) break;
    try {
      const lines = parseTrace(await readFile(path.join(dir, file.name), "utf8"));
      // A file with no line yet (a run that has only just started) is not a run.
      if (lines.length > 0) runs.push(lines);
    } catch {
      // An unreadable file is left out.
    }
  }
  return runs;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Nearest-rank percentile: the value at rank ceil(p/100 * n) of the sorted values; 0 for none. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

const emptyMetrics = (): TaskMetrics => ({
  runs: 0,
  by_status: { success: 0, needs_human: 0, error: 0, unknown: 0 },
  by_stop_reason: {},
  rounds: { 1: 0, 2: 0, 3: 0 },
  rejection_rate: 0,
  avg_model_calls: 0,
  avg_query_calls: 0,
  avg_tokens: 0,
  duration_ms: { p50: 0, p95: 0 },
  queries: { zetaris: 0, local: 0, local_fallback: 0 },
  guards: { checked: 0, blocked: 0, injections_flagged: 0, advice_declined: 0 },
  strong_to_main_fallbacks: 0,
  memories: { recalled: 0, by_tag: 0 },
  prompt_versions: {},
});

function groupMetrics(runs: readonly RunLines[]): TaskMetrics {
  const metrics = emptyMetrics();
  metrics.runs = runs.length;
  let rejected = 0;
  let withEnd = 0;
  let modelCalls = 0;
  let queryCalls = 0;
  let tokens = 0;
  const durations: number[] = [];
  const versions = new Map<string, Map<string, number>>();
  for (const lines of runs) {
    const summary = summarise("", lines);
    const end = [...lines].reverse().find((line) => line.agent_name === "Orchestrator" && line.action === "run_end");
    metrics.by_status[summary.status === "running" ? "unknown" : summary.status] += 1;
    if (summary.stop_reason !== null) metrics.by_stop_reason[summary.stop_reason] = (metrics.by_stop_reason[summary.stop_reason] ?? 0) + 1;
    const rounds = String(Math.max(0, ...lines.map((line) => num(line.retry_count))) + 1);
    metrics.rounds[rounds] = (metrics.rounds[rounds] ?? 0) + 1;
    if (lines.some((line) => line.agent_name === "Evaluator" && line.action === "reject")) rejected += 1;
    if (end !== undefined) {
      withEnd += 1;
      modelCalls += num(end.usage?.model_calls);
      queryCalls += num(end.usage?.query_calls);
      tokens += num(end.usage?.tokens_in) + num(end.usage?.tokens_out);
      durations.push(num(end.usage?.duration_ms));
    }
    const proof = proofFromTrace(lines);
    metrics.queries.zetaris += proof.zetaris.via_zetaris;
    metrics.queries.local += proof.zetaris.local;
    metrics.queries.local_fallback += proof.zetaris.fallback;
    metrics.guards.checked += proof.guards.checked;
    metrics.guards.blocked += proof.guards.blocked;
    metrics.guards.injections_flagged += proof.guards.injections_flagged;
    metrics.guards.advice_declined += proof.guards.advice_declined;
    metrics.strong_to_main_fallbacks += proof.nemotron.strong_to_main_fallbacks;
    metrics.memories.recalled += proof.meterless.memories_recalled;
    metrics.memories.by_tag += proof.meterless.taken_by_tag;
    // One run counts once for each prompt hash an agent used in it.
    const seen = new Set<string>();
    for (const line of lines) {
      if (typeof line.prompt_hash !== "string" || line.prompt_hash === "") continue;
      const key = `${line.agent_name}\u0000${line.prompt_hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const perAgent = versions.get(line.agent_name) ?? new Map<string, number>();
      perAgent.set(line.prompt_hash, (perAgent.get(line.prompt_hash) ?? 0) + 1);
      versions.set(line.agent_name, perAgent);
    }
  }
  if (runs.length > 0) metrics.rejection_rate = rejected / runs.length;
  if (withEnd > 0) {
    metrics.avg_model_calls = modelCalls / withEnd;
    metrics.avg_query_calls = queryCalls / withEnd;
    metrics.avg_tokens = tokens / withEnd;
  }
  durations.sort((a, b) => a - b);
  metrics.duration_ms = { p50: percentile(durations, 50), p95: percentile(durations, 95) };
  for (const [agent, hashes] of versions) {
    metrics.prompt_versions[agent] = [...hashes]
      .map(([prompt_hash, count]) => ({ prompt_hash, runs: count }))
      .sort((a, b) => b.runs - a.runs || a.prompt_hash.localeCompare(b.prompt_hash));
  }
  return metrics;
}

/** The task of a run: its run_end line's, else its last line's, else "unknown" (a trace from before the task was written). */
export function taskOf(lines: RunLines): string {
  return summarise("", lines).task ?? UNKNOWN_TASK;
}

/** The numbers for all runs together (key "all") and for each task. Pure. */
export function metricsFromTraces(runs: readonly RunLines[]): Metrics {
  const byTask = new Map<string, RunLines[]>();
  for (const lines of runs) {
    const task = taskOf(lines);
    byTask.set(task, [...(byTask.get(task) ?? []), lines]);
  }
  const metrics: Metrics = { [ALL_RUNS]: groupMetrics(runs) };
  for (const [task, group] of byTask) metrics[task] = groupMetrics(group);
  return metrics;
}

/**
 * What GET /metrics and `npm run metrics -- --json` return, one flat object: runs_read, the newest and oldest line
 * timestamps, and the metrics under "all" and under each task. Read typed numbers with metricsFromTraces.
 */
export type MetricsPayload = { runs_read: number; newest: string | null; oldest: string | null } & Record<string, unknown>;

export function metricsPayload(runs: readonly RunLines[]): MetricsPayload {
  const times = runs.flatMap((lines) => lines.map((line) => line.timestamp)).filter((time) => typeof time === "string" && time !== "").sort();
  return { runs_read: runs.length, newest: times[times.length - 1] ?? null, oldest: times[0] ?? null, ...metricsFromTraces(runs) };
}

/** Clamps a ?limit= or --limit value: a whole number from 1 to MAX_RUN_LIMIT, else the default. */
export function runLimit(value: string | null | undefined): number {
  const n = Number(value);
  if (value === null || value === undefined || value.trim() === "" || !Number.isInteger(n) || n < 1) return DEFAULT_RUN_LIMIT;
  return Math.min(n, MAX_RUN_LIMIT);
}

const one = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const counts = (record: Record<string, number>): string => {
  const parts = Object.entries(record).map(([key, n]) => `${key} ${n}`);
  return parts.length === 0 ? "none" : parts.join(", ");
};

/** One group's numbers as [name, value] text rows: the page's table and `npm run metrics` print the same rows. */
export function metricRows(m: TaskMetrics): [string, string][] {
  return [
    ["Runs", String(m.runs)],
    ["Status", counts(m.by_status)],
    ["Stop reasons", counts(m.by_stop_reason)],
    ["Rounds", counts(m.rounds)],
    ["Rejection rate", `${one(Math.round(m.rejection_rate * 1000) / 10)}%`],
    ["Model calls per run", one(Math.round(m.avg_model_calls * 10) / 10)],
    ["Query calls per run", one(Math.round(m.avg_query_calls * 10) / 10)],
    ["Tokens per run", String(Math.round(m.avg_tokens))],
    ["Duration p50 / p95", `${seconds(m.duration_ms.p50)} / ${seconds(m.duration_ms.p95)}`],
    ["Queries", `zetaris ${m.queries.zetaris}, local ${m.queries.local}, local-fallback ${m.queries.local_fallback}`],
    ["Guards", `checked ${m.guards.checked}, blocked ${m.guards.blocked}, injections flagged ${m.guards.injections_flagged}, advice declined ${m.guards.advice_declined}`],
    ["Strong to main fallbacks", String(m.strong_to_main_fallbacks)],
    ["Memories", `recalled ${m.memories.recalled}, by tag ${m.memories.by_tag}`],
  ];
}

/** Every agent's prompt hashes with their run counts, as flat rows, agents in name order. */
export function promptVersionRows(m: TaskMetrics): { agent: string; prompt_hash: string; runs: number }[] {
  return Object.keys(m.prompt_versions)
    .sort()
    .flatMap((agent) => m.prompt_versions[agent].map((version) => ({ agent, ...version })));
}
