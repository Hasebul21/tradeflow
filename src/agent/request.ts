// The request envelope shared by POST /run, scripts/agent.ts and scripts: { run_id?, input, options? } in, one
// orchestrator result out. It checks the envelope (run id pattern, field types), resolves the sample mode from
// config.ts and the request's options.sample_mode, and calls run(). The task and question rules live in
// orchestrator.ts, so every caller gets the same InvalidInput errors. Never throws: any failure is a structured
// error reply with zero usage. Server only (run() writes the trace).
import { randomUUID } from "node:crypto";
import { loadConfig, type Config } from "./config";
import { topLevelCount } from "./registry";
import { RUN_ID_PATTERN, run, type RunError, type RunInput, type RunOptions, type RunResult } from "./orchestrator";

export type RunRequest = { run_id?: string | null; input?: RunInput | null; options?: { sample_mode?: boolean | null } | null };

/** The status line of an HTTP reply: 400 for InvalidInput, 500 for any other error, 200 for the rest. */
export function httpStatusOf(result: Pick<RunResult, "status" | "error">): number {
  if (result.status !== "error") return 200;
  return result.error?.type === "InvalidInput" ? 400 : 500;
}

/** Seconds a Busy client waits before it asks again. */
export const BUSY_RETRY_AFTER_S = 5;

/**
 * The 429 body for a server that already runs MAX_CONCURRENT_RUNS top-level runs, or null when there is room. It reads
 * only the registry and the config, so nothing is traced and no file is written. A setting that fails to load is not
 * this check's to report: the run's own InvalidInput/Config reply says so.
 */
export function busyReply(running: number = topLevelCount(), env: Record<string, string | undefined> = process.env): { status: "error"; error: RunError; usage: RunResult["usage"] } | null {
  let cap: number;
  try {
    cap = loadConfig(env, () => {}).MAX_CONCURRENT_RUNS;
  } catch {
    return null;
  }
  if (running < cap) return null;
  return {
    status: "error",
    error: { type: "Busy", message: `The server is running ${running} runs; try again in a few seconds.`, recoverable: true },
    usage: { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * SAMPLE_MODE=true: sample. SAMPLE_MODE=false: the real model (loadConfig throws without a key). SAMPLE_MODE empty:
 * the key rule in loadConfig, and options.sample_mode true turns sample mode on for this request; false or absent
 * changes nothing.
 */
export function resolveSampleMode(config: Config, requested: boolean | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const setting = (env.SAMPLE_MODE ?? "").trim().toLowerCase();
  if (setting === "true" || setting === "false") return config.sampleMode;
  return config.sampleMode || requested === true;
}

function failure(runId: string, task: string, error: RunError, started: number): RunResult {
  const usage = { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: Date.now() - started };
  return { run_id: runId, task, status: "error", output: null, error, agents: [], usage, trace_id: runId, log_file: null, execution_time_seconds: usage.duration_ms / 1000 };
}

/**
 * Checks the envelope, then runs. `body` is whatever was parsed from the request: it may be anything. `extra` is for
 * trusted callers only (scripts/eval.ts), never from a request body: localReason keeps every query local.
 */
export async function runRequest(body: unknown, extra: Pick<RunOptions, "localReason"> = {}): Promise<RunResult> {
  const started = Date.now();
  const invalid = (runId: string, task: string, message: string) => failure(runId, task, { type: "InvalidInput", message, recoverable: false }, started);
  const runId0 = isObject(body) && typeof body.run_id === "string" ? body.run_id : "";
  try {
    if (!isObject(body)) return invalid(runId0, "explain_week", "The body must be a JSON object.");
    const given = body.run_id;
    if (given !== undefined && given !== null && (typeof given !== "string" || !RUN_ID_PATTERN.test(given))) {
      return invalid(runId0, "explain_week", "run_id must match /^[A-Za-z0-9_-]{1,80}$/.");
    }
    const runId = typeof given === "string" ? given : randomUUID();

    const rawInput = body.input === undefined || body.input === null ? {} : body.input;
    if (!isObject(rawInput)) return invalid(runId, "explain_week", "input must be an object.");
    const task = rawInput.task;
    if (task !== undefined && task !== null && typeof task !== "string") return invalid(runId, "explain_week", "task must be a string.");
    for (const field of ["question", "as_of", "plan_id", "review_run_id", "text", "issue_id"] as const) {
      const value = rawInput[field];
      if (value !== undefined && value !== null && typeof value !== "string") return invalid(runId, task ?? "explain_week", `${field} must be a string.`);
    }
    if (rawInput.trade !== undefined && rawInput.trade !== null && !isObject(rawInput.trade)) return invalid(runId, task ?? "explain_week", "trade must be an object.");
    const wrong = rawInput.wrong_memory_ids;
    if (wrong !== undefined && wrong !== null && (!Array.isArray(wrong) || wrong.some((id) => typeof id !== "string"))) {
      return invalid(runId, task ?? "explain_week", "wrong_memory_ids must be a list of memory ids.");
    }

    const options = body.options === undefined || body.options === null ? {} : body.options;
    if (!isObject(options)) return invalid(runId, task ?? "explain_week", "options must be an object.");
    const sample = options.sample_mode;
    if (sample !== undefined && sample !== null && typeof sample !== "boolean") return invalid(runId, task ?? "explain_week", "options.sample_mode must be true or false.");

    const config = loadConfig();
    const { task: _task, ...input } = rawInput;
    return await run({
      runId,
      task: task ?? undefined,
      input: input as RunInput,
      sampleMode: resolveSampleMode(config, sample),
      config,
      ...(extra.localReason === undefined ? {} : { localReason: extra.localReason }),
    });
  } catch (error) {
    const type = error instanceof Error ? error.name : "Internal";
    const message = error instanceof Error ? error.message : String(error);
    return failure(runId0, "explain_week", { type: type === "Error" ? "Internal" : type, message, recoverable: false }, started);
  }
}
