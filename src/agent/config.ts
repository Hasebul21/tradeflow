// The one place that reads settings. Every key and setting comes from process.env (loaded from .env by
// `node --env-file-if-exists=.env`, Next.js or docker --env-file); this module never opens .env itself.
// Server only: no client component or edge route imports it.
import { z } from "zod";

/** What loadConfig reads: process.env, or a plain object in a test. */
export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Tier = "strong" | "main" | "fast";

export type Config = {
  readonly MAX_ROUNDS: number;
  readonly MAX_QUERY_CALLS: number;
  readonly MAX_MODEL_CALLS: number;
  readonly MAX_PLAN_STEPS: number;
  readonly MAX_TOOL_ROUNDS: number;
  readonly MAX_TOKENS_PER_RUN: number;
  readonly QUERY_TIMEOUT_MS: number;
  readonly MODEL_TIMEOUT_MS: number;
  readonly MODEL_TIMEOUT_STRONG_MS: number;
  readonly ROUND_TIMEOUT_MS: number;
  readonly RUN_TIMEOUT_MS: number;
  /** The whole weekly briefing: its three child runs together; each child gets the time left (its own RUN_TIMEOUT_MS if smaller). */
  readonly BRIEFING_TIMEOUT_MS: number;
  /** How many briefing children run at once; 1 runs them one after another. Set it to 1 if the model provider rate-limits parallel calls. */
  readonly MAX_CONCURRENT_CHILDREN: number;
  /** How many top-level runs POST /run takes at once; the next one gets 429 Busy with Retry-After. Briefing children never count. */
  readonly MAX_CONCURRENT_RUNS: number;
  readonly MAX_ROWS_PER_QUERY: number;
  readonly MAX_MEMORIES: number;
  readonly MAX_PROMPT_CHARS: number;
  readonly TEMPERATURE: number;
  readonly MAX_COMPLETION_TOKENS: number;
  readonly PORT: number;
  readonly LOG_LEVEL: LogLevel;
  /** Normalised to end in /v1 with no trailing slash. No default in code. */
  readonly METERLESS_BASE_URL: string | undefined;
  /** The Nightshift runtime token. Never log it. */
  readonly METERLESS_API_KEY: string | undefined;
  readonly NEMOTRON_MODEL_STRONG: string | undefined;
  readonly NEMOTRON_MODEL_MAIN: string | undefined;
  readonly NEMOTRON_MODEL_FAST: string | undefined;
  readonly models: { readonly strong: string | undefined; readonly main: string | undefined; readonly fast: string | undefined };
  /** True when the sample model runs instead of Nightshift. */
  readonly sampleMode: boolean;
  /** Set only when ZETARIS_REST_URL, ZETARIS_ORG_ID and ZETARIS_API_KEY are all non-empty. */
  readonly zetaris: {
    readonly restUrl: string;
    readonly orgId: string;
    readonly apiKey: string;
    readonly username: string | undefined;
    readonly password: string | undefined;
  } | null;
};

export type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** The longest one model call may run. Raised from 240000 on 23 Oct: the model is slow some days and a cold load takes minutes. */
export const MODEL_TIMEOUT_CAP_MS = 420000;

/** The wait before llm.ts's one transport retry (a timeout, a 429, a 5xx, a network error). */
export const MODEL_RETRY_BACKOFF_MS = 300;

const MINUTE_MS = 60_000;
const upToMinute = (ms: number): number => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;

/**
 * ROUND_TIMEOUT_MS by default: round 1's worst case, with every call at MODEL_TIMEOUT_CAP_MS (420 s). The round's
 * deadline covers the Planner, the Analyst and the Evaluator, and the Writer, which runs inside the accepted round:
 *   the Planner with one full retry      2 × 420 s + 0.3 s backoff = 840.3 s
 *   the Analyst's three calls            (MAX_TOOL_ROUNDS 2 tool rounds, then the answer) 3 × 420 s = 1260 s
 *   the Evaluator's scoring call         420 s
 *   the Writer's call                    420 s
 *   queries and code                     60 s
 *   in all 3000.3 s, up to whole minutes: 51 min (3,060,000 ms).
 * Raised from 900000 on 23 Oct so the Planner's retry fits: a plan built in code never passes the eval.
 */
export const ROUND_TIMEOUT_DEFAULT_MS = upToMinute(2 * MODEL_TIMEOUT_CAP_MS + MODEL_RETRY_BACKOFF_MS + 3 * MODEL_TIMEOUT_CAP_MS + 2 * MODEL_TIMEOUT_CAP_MS + MINUTE_MS);

/**
 * RUN_TIMEOUT_MS by default: two full rounds (2 × 51 min, the second with the Writer), one more model call (the
 * Router before round 1, or the Writer after round 2's Evaluator) and 60 s to set up: 6120 + 420 + 60 = 6600 s,
 * 110 min (6,600,000 ms). A third round runs only in the time that is left.
 */
export const RUN_TIMEOUT_DEFAULT_MS = upToMinute(2 * ROUND_TIMEOUT_DEFAULT_MS + MODEL_TIMEOUT_CAP_MS + MINUTE_MS);

/**
 * BRIEFING_TIMEOUT_MS by default: its three children run MAX_CONCURRENT_CHILDREN (2) at a time, so in two waves, and
 * each child gets the briefing's time left as its RUN_TIMEOUT_MS when that is smaller. Two whole runs back to back give
 * the last child its full run: 2 × 110 min = 220 min (13,200,000 ms). With MAX_CONCURRENT_CHILDREN 1 the third child
 * gets only what is left.
 */
export const BRIEFING_TIMEOUT_DEFAULT_MS = upToMinute(2 * RUN_TIMEOUT_DEFAULT_MS);

/** max_tokens for llm.ts's retries after a 502 "empty_response" (at least MAX_COMPLETION_TOKENS). */
export const EMPTY_RESPONSE_RETRY_MAX_TOKENS = 32000;

/**
 * Tries in total for one model call whose replies are 502 "empty_response", when the caller passes the round's end
 * (roundDeadlineMs). A retry starts only while at least MODEL_TIMEOUT_CAP_MS of the round is left after its wait.
 */
export const EMPTY_RESPONSE_MAX_TRIES = 3;

/**
 * Tries in total for one model call that times out, when the caller passes the round's end (roundDeadlineMs). Each
 * retry is a whole new attempt (MODEL_TIMEOUT_CAP_MS) and starts only while the backoff and a whole attempt (and the
 * Planner's reserveAfterMs) still fit in the round, which never runs past the run's end. Without the round's end, one
 * retry, as before. Raised from 2 on 23 Oct: a slow model day should be waited out, not given up on.
 */
export const TIMEOUT_MAX_TRIES = 3;

/** The wait before try 2 and before try 3 of an empty_response retry; it comes out of the round's time left. */
export const EMPTY_RESPONSE_RETRY_WAITS_MS: readonly number[] = [15000, 30000];

/**
 * Tries in total for one JSON model call whose reply does not parse or fails the agent's schema, when the caller passes
 * the round's end (roundDeadlineMs). Each retry says what was wrong and restates the shape, and starts only while at
 * least MODEL_TIMEOUT_CAP_MS of the round is left. Without the round's end, one retry, as before.
 */
export const STRUCTURED_REPLY_MAX_TRIES = 3;

/** The Writer's attempts: one retry with retry_reason after a review fails its code check, then needs_human. */
export const WRITER_MAX_ATTEMPTS = 2;

/**
 * MAX_MODEL_CALLS by default. Every request counts as a model call, each retry included (llm.ts, modelCallsLeft), so
 * the budget holds MAX_ROUNDS (3) rounds in which every agent call uses all 3 of its tries (STRUCTURED_REPLY_MAX_TRIES,
 * EMPTY_RESPONSE_MAX_TRIES and TIMEOUT_MAX_TRIES are all 3):
 *   the Router, once before round 1                                   1
 *   one round: the Planner                       1 call  × 3 tries     3
 *              the Analyst (MAX_TOOL_ROUNDS 2 + 1) 3 calls × 3 tries    9
 *              the Evaluator                     1 call  × 3 tries     3
 *   three rounds                                 3 × 15               45
 *   the Writer (WRITER_MAX_ATTEMPTS)             2 calls × 3 tries     6
 *   in all 1 + 45 + 6 = 52.
 * Raised from 12 on 23 Oct: with retries counted, a 3-round run stopped on model_calls, giving up on the budget, not
 * on the model. A call whose structured retries each also meet a transport retry can still pass 52; the run then ends
 * needs_human with stop_reason model_calls, so the loop stays bounded.
 */
export const MAX_MODEL_CALLS_DEFAULT =
  1 + 3 * (STRUCTURED_REPLY_MAX_TRIES + 3 * STRUCTURED_REPLY_MAX_TRIES + STRUCTURED_REPLY_MAX_TRIES) + WRITER_MAX_ATTEMPTS * STRUCTURED_REPLY_MAX_TRIES;

/** The mean tokens (in plus out) of one real-model call: the 25 ok model_call lines in logs/trace-example_*.jsonl, 23 Oct. */
export const TOKENS_PER_CALL_TYPICAL = 11652;

/**
 * MAX_TOKENS_PER_RUN by default: MAX_MODEL_CALLS_DEFAULT (52) calls at TOKENS_PER_CALL_TYPICAL (11,652) tokens each,
 * 605,904, up to whole 10,000s: 610,000. Raised from 250000 on 23 Oct with MAX_MODEL_CALLS. A failed request (a
 * timeout or a 502 empty_response) uses no tokens, so a run of flaky calls stays well under it; the Analyst's calls
 * are the largest (a mean of 18,986), so a run whose every Analyst call is retried may stop on tokens first.
 */
export const MAX_TOKENS_PER_RUN_DEFAULT = Math.ceil((MAX_MODEL_CALLS_DEFAULT * TOKENS_PER_CALL_TYPICAL) / 10_000) * 10_000;

/** A briefing child starts only while at least this much of BRIEFING_TIMEOUT_MS is left; below it the child's section is skipped. */
export const BRIEFING_MIN_CHILD_MS = 5000;

/** The Nightshift placeholder token; it is never a real credential. */
const REJECTED_KEYS = new Set(["rt-local"]);

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const limitsSchema = z.object({
  MAX_ROUNDS: positiveInt(3),
  MAX_QUERY_CALLS: positiveInt(20),
  MAX_MODEL_CALLS: positiveInt(MAX_MODEL_CALLS_DEFAULT),
  MAX_PLAN_STEPS: positiveInt(5),
  MAX_TOOL_ROUNDS: positiveInt(2),
  MAX_TOKENS_PER_RUN: positiveInt(MAX_TOKENS_PER_RUN_DEFAULT),
  QUERY_TIMEOUT_MS: positiveInt(20000),
  MODEL_TIMEOUT_MS: positiveInt(MODEL_TIMEOUT_CAP_MS),
  MODEL_TIMEOUT_STRONG_MS: positiveInt(MODEL_TIMEOUT_CAP_MS),
  ROUND_TIMEOUT_MS: positiveInt(ROUND_TIMEOUT_DEFAULT_MS),
  RUN_TIMEOUT_MS: positiveInt(RUN_TIMEOUT_DEFAULT_MS),
  BRIEFING_TIMEOUT_MS: positiveInt(BRIEFING_TIMEOUT_DEFAULT_MS),
  MAX_CONCURRENT_CHILDREN: positiveInt(2),
  MAX_CONCURRENT_RUNS: positiveInt(2),
  MAX_ROWS_PER_QUERY: positiveInt(50),
  MAX_MEMORIES: positiveInt(5),
  MAX_PROMPT_CHARS: positiveInt(40000),
  TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  MAX_COMPLETION_TOKENS: positiveInt(16000),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
});

const LIMIT_NAMES = Object.keys(limitsSchema.shape);

/** An empty or whitespace-only value counts as unset. */
function read(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** https://host, https://host/, https://host/v1 and https://host/v1/ all become https://host/v1. */
function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function readKey(env: Env): string | undefined {
  // NVIDIA_API_KEY is deliberately absent: it lives in Nightshift's Providers tab, never here.
  const key = read(env, "METERLESS_API_KEY", "METERLESS_RUNTIME_TOKEN", "MODEL_API_KEY");
  return key !== undefined && REJECTED_KEYS.has(key) ? undefined : key;
}

function parseLimits(env: Env) {
  const raw: Record<string, string> = {};
  for (const name of LIMIT_NAMES) {
    const value = read(env, name);
    if (value !== undefined) raw[name] = value;
  }
  const parsed = limitsSchema.safeParse(raw);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new ConfigError(`Invalid value for ${names.join(", ")}: expected a number in range.`);
  }
  return parsed.data;
}

function parseLogLevel(env: Env): LogLevel {
  const value = read(env, "LOG_LEVEL")?.toLowerCase();
  return LOG_LEVELS.find((level) => level === value) ?? "info";
}

/**
 * Builds the config from `env`. The sample-mode and Zetaris reasons are logged once per call, through `log`
 * (console.warn by default), and only at LOG_LEVEL info or debug.
 */
export function loadConfig(env: Env = process.env, log: (message: string) => void = console.warn): Config {
  const limits = parseLimits(env);
  const logLevel = parseLogLevel(env);
  const say = (message: string) => {
    if (logLevel === "debug" || logLevel === "info") log(`[config] ${message}`);
  };

  const apiKey = readKey(env);
  const baseUrlRaw = read(env, "METERLESS_BASE_URL", "MODEL_BASE_URL");
  const baseUrl = baseUrlRaw === undefined ? undefined : normaliseBaseUrl(baseUrlRaw);
  const strong = read(env, "NEMOTRON_MODEL_STRONG");
  const main = read(env, "NEMOTRON_MODEL_MAIN", "METERLESS_MODEL", "NEMOTRON_MODEL", "MODEL_NAME");
  const fast = read(env, "NEMOTRON_MODEL_FAST");

  // A key counts only when the base URL and all three model ids are set too.
  const missing: string[] = [];
  if (apiKey === undefined) missing.push("METERLESS_API_KEY");
  if (baseUrl === undefined) missing.push("METERLESS_BASE_URL");
  if (strong === undefined) missing.push("NEMOTRON_MODEL_STRONG");
  if (main === undefined) missing.push("NEMOTRON_MODEL_MAIN");
  if (fast === undefined) missing.push("NEMOTRON_MODEL_FAST");

  const mode = read(env, "SAMPLE_MODE")?.toLowerCase();
  let sampleMode: boolean;
  if (mode === "true") {
    sampleMode = true;
  } else if (mode === "false") {
    if (missing.length > 0) {
      throw new ConfigError(`SAMPLE_MODE=false needs the real model, but these are empty: ${missing.join(", ")}.`);
    }
    sampleMode = false;
  } else if (mode === undefined) {
    sampleMode = missing.length > 0;
    if (sampleMode) {
      // With no key the other names are beside the point; with a key, name each empty one.
      const reason = missing[0] === "METERLESS_API_KEY" ? "no METERLESS_API_KEY" : `empty ${missing.join(", ")}`;
      say(`Sample mode: ${reason}.`);
    }
  } else {
    throw new ConfigError(`SAMPLE_MODE must be "true", "false" or empty.`);
  }

  const zetarisUrl = read(env, "ZETARIS_REST_URL");
  const zetarisOrg = read(env, "ZETARIS_ORG_ID");
  const zetarisKey = read(env, "ZETARIS_API_KEY");
  const zetarisMissing = [
    zetarisUrl === undefined ? "ZETARIS_REST_URL" : null,
    zetarisOrg === undefined ? "ZETARIS_ORG_ID" : null,
    zetarisKey === undefined ? "ZETARIS_API_KEY" : null,
  ].filter((name): name is string => name !== null);
  if (zetarisMissing.length > 0) say(`Queries run locally: empty ${zetarisMissing.join(", ")}.`);
  const zetaris =
    zetarisUrl !== undefined && zetarisOrg !== undefined && zetarisKey !== undefined
      ? { restUrl: zetarisUrl, orgId: zetarisOrg, apiKey: zetarisKey, username: read(env, "ZETARIS_USERNAME"), password: read(env, "ZETARIS_PASSWORD") }
      : null;

  return {
    ...limits,
    MODEL_TIMEOUT_MS: Math.min(limits.MODEL_TIMEOUT_MS, MODEL_TIMEOUT_CAP_MS),
    MODEL_TIMEOUT_STRONG_MS: Math.min(limits.MODEL_TIMEOUT_STRONG_MS, MODEL_TIMEOUT_CAP_MS),
    LOG_LEVEL: logLevel,
    METERLESS_BASE_URL: baseUrl,
    METERLESS_API_KEY: apiKey,
    NEMOTRON_MODEL_STRONG: strong,
    NEMOTRON_MODEL_MAIN: main,
    NEMOTRON_MODEL_FAST: fast,
    models: { strong, main, fast },
    sampleMode,
    zetaris,
  };
}
