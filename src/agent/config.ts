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

/** max_tokens for llm.ts's retries after a 502 "empty_response" (at least MAX_COMPLETION_TOKENS). */
export const EMPTY_RESPONSE_RETRY_MAX_TOKENS = 32000;

/**
 * Tries in total for one model call whose replies are 502 "empty_response", when the caller passes the round's end
 * (roundDeadlineMs). A retry starts only while at least MODEL_TIMEOUT_CAP_MS of the round is left after its wait.
 */
export const EMPTY_RESPONSE_MAX_TRIES = 3;

/** The wait before try 2 and before try 3 of an empty_response retry; it comes out of the round's time left. */
export const EMPTY_RESPONSE_RETRY_WAITS_MS: readonly number[] = [15000, 30000];

/**
 * Tries in total for one JSON model call whose reply does not parse or fails the agent's schema, when the caller passes
 * the round's end (roundDeadlineMs). Each retry says what was wrong and restates the shape, and starts only while at
 * least MODEL_TIMEOUT_CAP_MS of the round is left. Without the round's end, one retry, as before.
 */
export const STRUCTURED_REPLY_MAX_TRIES = 3;

/** A briefing child starts only while at least this much of BRIEFING_TIMEOUT_MS is left; below it the child's section is skipped. */
export const BRIEFING_MIN_CHILD_MS = 5000;

/** The Nightshift placeholder token; it is never a real credential. */
const REJECTED_KEYS = new Set(["rt-local"]);

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const limitsSchema = z.object({
  MAX_ROUNDS: positiveInt(3),
  MAX_QUERY_CALLS: positiveInt(20),
  MAX_MODEL_CALLS: positiveInt(12),
  MAX_PLAN_STEPS: positiveInt(5),
  MAX_TOOL_ROUNDS: positiveInt(2),
  MAX_TOKENS_PER_RUN: positiveInt(250000),
  QUERY_TIMEOUT_MS: positiveInt(20000),
  MODEL_TIMEOUT_MS: positiveInt(MODEL_TIMEOUT_CAP_MS),
  MODEL_TIMEOUT_STRONG_MS: positiveInt(MODEL_TIMEOUT_CAP_MS),
  ROUND_TIMEOUT_MS: positiveInt(900000),
  RUN_TIMEOUT_MS: positiveInt(2400000),
  BRIEFING_TIMEOUT_MS: positiveInt(1200000),
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
