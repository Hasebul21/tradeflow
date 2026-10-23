// One JSON line per agent step, guard decision, retry, fallback, escalation and approval, in
// logs/trace-<run_id>.jsonl and as a readable line on stdout. Server only (node:fs).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TraceStatus = "ok" | "retry" | "fallback" | "cached" | "rejected" | "blocked" | "accepted" | "needs_human" | "error";

/**
 * A model_call line carries the call's tokens and model_calls 1; a Query line that ran carries query_calls 1; the
 * run_end line carries the run's total. Adding up every other line of a run gives the run_end line's usage.
 */
export type TraceUsage = {
  tokens_in?: number;
  tokens_out?: number;
  model_calls?: number;
  query_calls?: number;
  duration_ms?: number;
};

export type TraceLine = {
  timestamp: string;
  run_id: string;
  task?: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent: string | null;
  model: string | null;
  /** The Evaluator's total out of 9 as a fraction rounded to two decimals: 7 of 9 is 0.78. */
  confidence: number | null;
  /** The loop round: 0 in the first. */
  retry_count: number;
  status: TraceStatus;
  why?: string;
  duration_ms?: number;
  /** Written only on the final run_end line. */
  stop_reason?: string;
  escalation_rule?: string;
  usage?: TraceUsage;
  /** Model calls (llm.ts): the retries made inside one call. retry_count stays the loop round. */
  model_retries?: number;
  /** The meterless/* id that was sent, which names the lane. */
  requested_model?: string;
  /** The model the reply reports; left out when it names none. */
  reported_model?: string;
  /** From the Nightshift receipt (meterless.routed_model); left out when absent. */
  routed_model?: string;
  /** From the Nightshift receipt (meterless.cost.actual_usd); left out when absent. */
  cost_usd?: number;
  /** The host name of METERLESS_BASE_URL, never the full URL. */
  provider_host?: string;
  /** Model lines of an agent with a prompt file: the first 8 hex characters of the SHA-256 of that file (prompts.ts). */
  prompt_hash?: string;
  fallback?: "strong->main";
  /** Query lines: where the rows came from, "local", "zetaris" or "local-fallback". */
  source?: "local" | "zetaris" | "local-fallback";
  /** Written only on an Orchestrator "handoff" line: the run id of the child run it handed to (the briefing's children). */
  child_run_id?: string;
  /** Written only on an Orchestrator "handoff" line: ISO timestamps of when that child started and ended, so overlapping children show. */
  started_at?: string;
  finished_at?: string;
  /** Memory recall lines: the H-MEM query's trace.retrievalReason and trace.strategy. */
  retrievalReason?: string;
  strategy?: string;
};

/** What a caller passes: the five fields that always differ, the rest default to null or 0. */
export type TraceInput = Pick<TraceLine, "agent_name" | "action" | "input_summary" | "output_summary" | "status"> &
  Partial<Omit<TraceLine, "timestamp" | "run_id" | "task">>;

// Keep in step with the `key` pattern in .claude/hooks/guard-prompt.mjs (trace.test.ts compares the two).
export const SECRET_PATTERN =
  /nvapi-[A-Za-z0-9_-]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|postgres(ql)?:\/\/[^:\/ ]+:[^@ <>]+@|BEGIN (RSA|OPENSSH) PRIVATE KEY/g;

// METERLESS_BASE_URL and MODEL_BASE_URL are URLs, not secrets, so they are not here.
export const SECRET_ENV_NAMES = [
  "METERLESS_API_KEY",
  "METERLESS_RUNTIME_TOKEN",
  "MODEL_API_KEY",
  "NVIDIA_API_KEY",
  "ZETARIS_API_KEY",
  "ZETARIS_PASSWORD",
  "ZETARIS_DB_PASSWORD",
  "PGPASS",
] as const;

/** A shorter value would match ordinary text; the hooks use the same floor. */
const MIN_SECRET_LENGTH = 12;
const MASK = "[masked]";

function secretValues(): string[] {
  return SECRET_ENV_NAMES.map((name) => process.env[name] ?? "").filter((value) => value.length >= MIN_SECRET_LENGTH);
}

function maskString(text: string, values: string[]): string {
  let out = text;
  for (const value of values) out = out.split(value).join(MASK);
  // $1 keeps the character that the sk- alternative matches before the key.
  return out.replace(SECRET_PATTERN, `$1${MASK}`);
}

function maskDeep<T>(value: T, values: string[]): T {
  if (typeof value === "string") return maskString(value, values) as T;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, values)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item, values)])) as T;
  }
  return value;
}

/** Masks every key-like string and the values of the secret variables that are 12 or more characters long. */
export function maskSecrets<T>(value: T): T {
  return maskDeep(value, secretValues());
}

export class Tracer {
  readonly runId: string;
  readonly file: string;
  private task: string | undefined;

  constructor(runId: string, file: string, task?: string) {
    this.runId = runId;
    this.file = file;
    this.task = task;
  }

  /** Sets the task written on later lines. It never touches the file. */
  setTask(task: string | undefined): void {
    this.task = task;
  }

  /** Appends one masked JSON line to the file, prints a readable line, and returns the line as written. */
  log(input: TraceInput): TraceLine {
    const line: TraceLine = maskSecrets({
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      ...(this.task === undefined ? {} : { task: this.task }),
      target_agent: null,
      model: null,
      confidence: null,
      retry_count: 0,
      // An explicit undefined must not erase a default.
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    } as TraceLine);
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    process.stdout.write(`${readable(line)}\n`);
    return line;
  }
}

function readable(line: TraceLine): string {
  const parts = [
    line.timestamp.slice(11, 19),
    line.run_id,
    line.task === undefined ? "-" : line.task,
    `${line.agent_name}.${line.action}`,
    line.status,
  ];
  if (line.model !== null) parts.push(`model=${line.model}`);
  if (line.confidence !== null) parts.push(`confidence=${line.confidence}`);
  if (line.retry_count > 0) parts.push(`round=${line.retry_count}`);
  if (line.duration_ms !== undefined) parts.push(`${line.duration_ms}ms`);
  return `${parts.join(" ")} | ${line.output_summary}`;
}

/** A run id becomes part of a file name, so it may not hold a path separator or start with a dot. */
export function isRunId(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(value);
}

/**
 * Starts logs/trace-<runId>.jsonl fresh, replacing a file with the same id, so each file holds one run. The task
 * is written on every line from the first; setTask changes it for later lines only.
 */
export function startRun(runId: string, options: { task?: string } = {}): Tracer {
  if (!isRunId(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}.`);
  const dir = path.resolve(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `trace-${runId}.jsonl`);
  writeFileSync(file, "");
  return new Tracer(runId, file, options.task);
}
