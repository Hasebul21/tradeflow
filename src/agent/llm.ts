// The one place that calls a model. Every call goes to the OpenAI-compatible endpoint in METERLESS_BASE_URL
// (Meterless Nightshift), or to sample-model.ts in sample mode. Server only: the key never leaves this module.
//
// openai-node retries by itself (maxRetries 2 by default). It is switched off here (maxRetries 0) so the retry
// count, the backoff and the trace lines are ours, and so one call makes at most the requests this file counts.
import OpenAI from "openai";
import {
  ConfigError,
  EMPTY_RESPONSE_MAX_TRIES,
  EMPTY_RESPONSE_RETRY_MAX_TOKENS,
  EMPTY_RESPONSE_RETRY_WAITS_MS,
  loadConfig,
  MODEL_TIMEOUT_CAP_MS,
  STRUCTURED_REPLY_MAX_TRIES,
  type Config,
  type Tier,
} from "./config";
import { BudgetExhaustedError } from "./run-state";
import { complete as completeWithSampleModel } from "./sample-model";
import type { Tracer, TraceInput } from "./trace";

export type AgentName = "Planner" | "Analyst" | "Evaluator" | "Writer" | "Memory" | "Router";

/** An OpenAI function definition, sent with tool_choice "auto". */
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;
/** Earlier assistant tool_calls messages and tool result messages, appended after the user message. */
export type HistoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type CompleteOptions = {
  system: string;
  user: string;
  model: Tier;
  json?: boolean;
  tools?: ToolSpec[];
  history?: HistoryMessage[];
  agent: AgentName;
  /** The first 8 hex characters of the SHA-256 of the agent's prompt file (prompts.ts); written on every model trace line, in sample mode too. */
  prompt_hash?: string;
  tracer?: Pick<Tracer, "log">;
  /** Default loadConfig(). */
  config?: Config;
  /** Default config.sampleMode. */
  sampleMode?: boolean;
  /** The time left for this call; the orchestrator passes it. Default: the tier's timeout from config. */
  timeoutMs?: number;
  /**
   * When the round ends (Date.now() milliseconds; the run's end when that comes first); the orchestrator passes it.
   * With it, a 502 empty_response gets up to EMPTY_RESPONSE_MAX_TRIES tries, each retry only while
   * MODEL_TIMEOUT_CAP_MS of the round is left after its wait. Without it, one retry, as before.
   */
  roundDeadlineMs?: number;
  /**
   * The model calls left in the run's budget (MAX_MODEL_CALLS minus those used). Every request counts as one model
   * call, retries included; a request past this number is not made: BudgetExhaustedError("max_model_calls").
   */
  modelCallsLeft?: number;
  /**
   * The run's cancel signal. It goes to the openai client as the request's `signal` (an abort ends the request and
   * the error is rethrown at once: never retried, never a fallback); in sample mode it is checked before the reply.
   */
  signal?: AbortSignal;
  /**
   * json calls only: checks the parsed reply against the agent's schema and returns a short reason when it fails, null
   * when it passes. A reply that fails is retried like one that does not parse; a reply with tool calls is not checked.
   * Sample mode never calls it: the sample model builds each reply to its schema.
   */
  validate?: (json: Record<string, unknown>) => string | null;
  /** json calls only: the reply's shape in one line, restated in the message that asks again after a bad reply. */
  replyShape?: string;
};

export type ToolCallResult = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** "bad_arguments": the arguments did not parse as a JSON object. The call must never be run. */
  error?: "bad_arguments";
};

export type CompleteResult = {
  /** null when the model answered with tool calls. */
  text: string | null;
  /** The parsed reply when json was true; null when the model answered with tool calls. */
  json?: Record<string, unknown> | null;
  usage: { tokens_in: number; tokens_out: number; estimate?: boolean } | null;
  duration_ms: number;
  /** The model the reply reports, or the requested id when the reply names none. */
  model_id: string;
  source: "nemotron" | "sample-model";
  fallback?: "strong->main";
  /** From the Nightshift receipt; absent when the reply has no meterless object or field. */
  routed_model?: string;
  cost_usd?: number;
  tool_calls?: ToolCallResult[];
  /** The requests this call made, retries included; each counts as one model call. Absent means 1. */
  model_calls?: number;
};

/** What a failed complete() spent: its requests (each one model call) and the tokens they reported. */
export type FailedCallUsage = { model_calls: number; tokens_in: number; tokens_out: number };
const FAILED_USAGE = Symbol("failedCallUsage");

/** The model calls and tokens a complete() that threw had spent; all zero for an error complete() did not throw. */
export function failedCallUsage(error: unknown): FailedCallUsage {
  const usage = error !== null && typeof error === "object" ? (error as { [FAILED_USAGE]?: FailedCallUsage })[FAILED_USAGE] : undefined;
  return usage ?? { model_calls: 0, tokens_in: 0, tokens_out: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Typed errors. None of the messages holds the key.

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class PromptTooLarge extends ModelError {}
/**
 * A reply that could not be used: it holds no JSON object ("parse"), or its object fails the agent's schema
 * ("schema"). `reason` says what was wrong in a few words; it is what a retry tells the model.
 */
export class BadJson extends ModelError {
  /** The first 200 characters of the reply. */
  readonly reply: string;
  readonly reason: string;
  readonly kind: "parse" | "schema";
  constructor(reply: string, reason = "", kind: "parse" | "schema" = "parse") {
    const excerpt = reply.slice(0, 200);
    const what = kind === "schema" ? "does not match the reply schema" : "is not a JSON object";
    super(`The model reply ${what}${reason === "" ? "" : ` (${reason})`}. Start of the reply: ${JSON.stringify(excerpt)}`);
    this.reply = excerpt;
    this.reason = reason;
    this.kind = kind;
  }
}
export class Unauthorized extends ModelError {}
export class NightshiftNotRunning extends ModelError {}
export class ModelTimeout extends ModelError {}
export class RateLimited extends ModelError {}
export class ModelHttpError extends ModelError {
  /** Undefined for a network error with no HTTP status. */
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// parseJsonReply

/**
 * The index of the "}" that closes the "{" at `start`, skipping braces inside JSON strings; -1 when it never closes
 * (the reply was cut off).
 */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Removes <think> blocks and Markdown fences, then takes the outermost balanced {...} spans in order (prose or a fence
 * around the object is fine) and returns the first that parses as a JSON object. A nested object is never taken
 * for the reply. Throws BadJson, with what was wrong as its reason.
 */
export function parseJsonReply(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```[A-Za-z0-9_-]*/g, "")
    .trim();
  if (cleaned === "") throw new BadJson(text, "the reply is empty");
  let start = cleaned.indexOf("{");
  if (start === -1) throw new BadJson(text, "the reply holds no {...} object");
  while (start !== -1) {
    const end = closingBrace(cleaned, start);
    if (end === -1) throw new BadJson(text, "the JSON object is cut off: a { is never closed");
    try {
      const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not JSON (prose in braces, or a malformed object): try the next outermost span.
    }
    start = cleaned.indexOf("{", end + 1);
  }
  throw new BadJson(text, "no {...} span in the reply parses as JSON");
}

// ---------------------------------------------------------------------------------------------------------------
// Per-model-id memory of what the provider rejected. Keyed by model id only: one model's quirk says nothing
// about another's. Each rejection is traced once, when it is first remembered.

const noJsonMode = new Set<string>();
const noReasoningSwitch = new Set<string>();

/** For tests: forget what was learned about each model id. */
export function resetModelQuirks(): void {
  noJsonMode.clear();
  noReasoningSwitch.clear();
}

const BACKOFF_MS = 300;
const JSON_ONLY_SENTENCE = "Reply with the JSON object only.";
const SOURCE_TIERS: Record<Tier, string> = { strong: "strong", main: "main", fast: "fast" };

// ---------------------------------------------------------------------------------------------------------------
// Error classification: by shape, not by instanceof, so it holds for the real SDK and for a mocked module.

type Failure =
  | { kind: "unauthorized"; status: number }
  | { kind: "refused" }
  | { kind: "bad_request"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "timeout" }
  | { kind: "rate_limit"; message: string }
  | { kind: "server"; status: number; message: string }
  | { kind: "network"; message: string }
  | { kind: "other"; status: number | undefined; message: string };

type ErrorLike = { name?: unknown; message?: unknown; status?: unknown; code?: unknown; cause?: unknown; errors?: unknown };

function isRefused(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== "object" || depth > 5) return false;
  const e = error as ErrorLike;
  if (e.code === "ECONNREFUSED") return true;
  if (typeof e.message === "string" && e.message.includes("ECONNREFUSED")) return true;
  if (Array.isArray(e.errors) && e.errors.some((inner) => isRefused(inner, depth + 1))) return true;
  return isRefused(e.cause, depth + 1);
}

function classify(error: unknown): Failure {
  const e = (error !== null && typeof error === "object" ? error : {}) as ErrorLike;
  const message = typeof e.message === "string" ? e.message : String(error);
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === 401 || status === 403) return { kind: "unauthorized", status };
  if (status === undefined && isRefused(error)) return { kind: "refused" };
  if (e.name === "APIConnectionTimeoutError" || (status === undefined && /timed out/i.test(message))) {
    return { kind: "timeout" };
  }
  if (status === 400) return { kind: "bad_request", message };
  if (status === 404) return { kind: "not_found", message };
  if (status === 429) return { kind: "rate_limit", message };
  if (status !== undefined && status >= 500) return { kind: "server", status, message };
  if (status === undefined && e.name === "APIConnectionError") return { kind: "network", message };
  return { kind: "other", status, message };
}

function scrub(text: string, cfg: Config): string {
  const key = cfg.METERLESS_API_KEY;
  const masked = key ? text.split(key).join("[masked]") : text;
  return masked.slice(0, 300);
}

// ---------------------------------------------------------------------------------------------------------------
// complete

type CallState = {
  cfg: Config;
  client: OpenAI;
  options: CompleteOptions;
  host: string;
  deadline: number | undefined;
  /** Requests made beyond the first one, apart from the strong-to-main fallback itself. */
  retries: number;
  /** Requests sent, retries and the fallback included: each one counts as a model call. */
  attempts: number;
  /** The attempts already counted on a retry trace line (usage.model_calls 1 each). */
  countedOnLines: number;
  usage: { tokens_in: number; tokens_out: number } | null;
};

type MeterlessReceipt = { meterless?: { routed_model?: unknown; cost?: { actual_usd?: unknown } } };

/** The prompt_hash field of a model trace line: left out when the caller has no prompt file (the Memory miner). */
function promptHashOf(options: CompleteOptions): { prompt_hash?: string } {
  return options.prompt_hash === undefined ? {} : { prompt_hash: options.prompt_hash };
}

export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const cfg = options.config ?? loadConfig();
  const sampleMode = options.sampleMode ?? cfg.sampleMode;
  const started = Date.now();
  // The history (earlier tool calls and their results) is part of the prompt, so it counts toward the limit.
  const historyChars = (options.history ?? []).reduce((n, message) => n + (JSON.stringify(message)?.length ?? 0), 0);
  const promptChars = options.system.length + options.user.length + historyChars;
  const baseLine = (): Pick<TraceInput, "agent_name" | "action" | "input_summary" | "prompt_hash"> => ({
    agent_name: options.agent,
    action: "model_call",
    input_summary: `${options.model} model, json=${options.json === true}, ${promptChars} prompt chars`,
    ...promptHashOf(options),
  });

  if (promptChars > cfg.MAX_PROMPT_CHARS) {
    const message = `The prompt is ${promptChars} characters (system, user and history), over MAX_PROMPT_CHARS (${cfg.MAX_PROMPT_CHARS}). It is never cut silently.`;
    options.tracer?.log({
      ...baseLine(),
      output_summary: "refused: prompt too large",
      status: "error",
      why: "prompt too large",
      duration_ms: Date.now() - started,
    });
    throw new PromptTooLarge(message);
  }

  if (sampleMode) {
    // A run that was stopped before this call makes no request, so nothing is counted.
    options.signal?.throwIfAborted();
    let result: CompleteResult;
    try {
      result = await completeWithSampleModel(options);
    } catch (error) {
      // A stand-in that throws (a test's failing model) is one failed request: it counts as a model call.
      if (error !== null && typeof error === "object") {
        Object.defineProperty(error, FAILED_USAGE, { value: { model_calls: 1, tokens_in: 0, tokens_out: 0 }, configurable: true });
      }
      options.tracer?.log({
        ...baseLine(),
        output_summary: `${error instanceof Error ? error.name : "Error"}: ${scrub(error instanceof Error ? error.message : String(error), cfg)}; 1 request counted as a model call`,
        status: "error",
        why: error instanceof ModelError ? error.name : "unexpected error",
        duration_ms: Date.now() - started,
        usage: { model_calls: 1 },
        model_retries: 0,
      });
      throw error;
    }
    options.tracer?.log({
      ...baseLine(),
      output_summary: `sample model answered, ${result.tool_calls?.length ?? 0} tool calls`,
      status: "ok",
      model: result.model_id,
      duration_ms: result.duration_ms,
      usage: { ...(result.usage === null ? {} : { tokens_in: result.usage.tokens_in, tokens_out: result.usage.tokens_out }), model_calls: 1 },
      model_retries: 0,
    });
    return result;
  }

  const requested = cfg.models[options.model];
  if (cfg.METERLESS_BASE_URL === undefined || cfg.METERLESS_API_KEY === undefined || requested === undefined) {
    throw new ConfigError(
      `The ${options.model} model needs METERLESS_BASE_URL, METERLESS_API_KEY and NEMOTRON_MODEL_${options.model.toUpperCase()}.`,
    );
  }

  const state: CallState = {
    cfg,
    client: new OpenAI({
      apiKey: cfg.METERLESS_API_KEY,
      baseURL: cfg.METERLESS_BASE_URL,
      defaultHeaders: { "meterless-app": "tradeflow", "meterless-scope": "user" },
      maxRetries: 0,
    }),
    options,
    host: new URL(cfg.METERLESS_BASE_URL).hostname,
    deadline: options.timeoutMs === undefined ? undefined : started + options.timeoutMs,
    retries: 0,
    attempts: 0,
    countedOnLines: 0,
    usage: null,
  };

  let lastRequested = requested;
  let fellBack = false;
  let strongFailure = "";
  try {
    let answered = await callWithFallback(state, options.model, options.user);
    fellBack = answered.fellBack;
    strongFailure = answered.strongFailure;
    lastRequested = answered.requested;

    let json: Record<string, unknown> | null | undefined;
    // A reply that does not parse, or fails the caller's schema, is asked for again: up to STRUCTURED_REPLY_MAX_TRIES
    // tries when the caller passed the round's end, else one retry. Each retry is traced and counted as a model call.
    const maxTries = options.roundDeadlineMs === undefined ? 2 : STRUCTURED_REPLY_MAX_TRIES;
    for (let tries = 1; answered.message.toolCalls === undefined && options.json === true; tries += 1) {
      const bad = structuralProblem(answered.message.text, options.validate);
      if (bad.json !== undefined) {
        json = bad.json;
        break;
      }
      const problem = bad.error;
      const correction = retryMessage(problem, options.replyShape);
      if (tries >= maxTries || !structuredRetryFits(state, promptChars + correction.length)) throw problem;
      state.retries += 1;
      options.tracer?.log({
        ...baseLine(),
        action: "model_retry",
        output_summary: scrub(
          `${problem.kind === "schema" ? "the reply fails the schema" : "the reply is empty or not JSON"} (${problem.reason}); try ${tries + 1} of ${maxTries}, saying what was wrong (that reply counted as a model call)`,
          cfg,
        ),
        status: "retry",
        usage: countAttemptOnLine(state),
        why: problem.kind === "schema" ? "reply failed the schema" : "unparseable JSON reply",
        model: answered.requested,
      });
      // The retry stays on the model that answered: no second fallback. The original messages stay as they were; the
      // correction is one more user message at the end.
      renewDeadlineInRound(state, answered.tier);
      const again = await callTier(state, answered.tier, options.user, [{ role: "user", content: correction }]);
      answered = { ...answered, message: again.message };
    }

    const message = answered.message;
    const toolCalls = message.toolCalls;
    const result: CompleteResult = {
      text: toolCalls === undefined ? message.text : null,
      ...(options.json === true || toolCalls !== undefined ? { json: toolCalls === undefined ? (json ?? null) : null } : {}),
      usage: state.usage,
      duration_ms: Date.now() - started,
      model_id: message.reportedModel ?? answered.requested,
      source: "nemotron",
      ...(fellBack ? { fallback: "strong->main" as const } : {}),
      ...(message.routedModel === undefined ? {} : { routed_model: message.routedModel }),
      ...(message.costUsd === undefined ? {} : { cost_usd: message.costUsd }),
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      model_calls: state.attempts,
    };

    options.tracer?.log({
      ...baseLine(),
      output_summary: fellBack
        ? `${strongFailure}; answered by the main model`
        : toolCalls === undefined
          ? `${message.text.length} characters`
          : `${toolCalls.length} tool calls`,
      status: fellBack ? "fallback" : "ok",
      ...(fellBack ? { why: "strong model unavailable" } : {}),
      model: result.model_id,
      duration_ms: result.duration_ms,
      usage: { ...(state.usage === null ? {} : { tokens_in: state.usage.tokens_in, tokens_out: state.usage.tokens_out }), model_calls: uncounted(state) },
      model_retries: state.retries,
      ...(fellBack ? { fallback: "strong->main" as const } : {}),
      requested_model: answered.requested,
      ...(message.reportedModel === undefined ? {} : { reported_model: message.reportedModel }),
      ...(message.routedModel === undefined ? {} : { routed_model: message.routedModel }),
      ...(message.costUsd === undefined ? {} : { cost_usd: message.costUsd }),
      provider_host: state.host,
    });
    return result;
  } catch (error) {
    // A failed call still counts: every request it made is a model call (it may be billed), with the tokens reported.
    const spent: FailedCallUsage = { model_calls: state.attempts, tokens_in: state.usage?.tokens_in ?? 0, tokens_out: state.usage?.tokens_out ?? 0 };
    if (error !== null && typeof error === "object") Object.defineProperty(error, FAILED_USAGE, { value: spent, configurable: true });
    const onLine = uncounted(state);
    options.tracer?.log({
      ...baseLine(),
      output_summary: `${error instanceof Error ? error.name : "Error"}: ${scrub(error instanceof Error ? error.message : String(error), cfg)}; ${state.attempts === 1 ? "1 request counted as a model call" : `${state.attempts} requests counted as model calls`}`,
      status: "error",
      ...(onLine > 0 || state.usage !== null
        ? { usage: { ...(state.usage === null ? {} : { tokens_in: state.usage.tokens_in, tokens_out: state.usage.tokens_out }), model_calls: onLine } }
        : {}),
      why: options.signal?.aborted ? "cancelled by the owner" : error instanceof ModelError ? error.name : "unexpected error",
      model: lastRequested,
      duration_ms: Date.now() - started,
      model_retries: state.retries,
      ...(fellBack ? { fallback: "strong->main" as const } : {}),
      requested_model: lastRequested,
      provider_host: state.host,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One model call: fallback, retry, request building.

type ParsedMessage = {
  text: string;
  toolCalls: ToolCallResult[] | undefined;
  reportedModel: string | undefined;
  routedModel: string | undefined;
  costUsd: number | undefined;
};

type Answered = {
  message: ParsedMessage;
  tier: Tier;
  requested: string;
  fellBack: boolean;
  strongFailure: string;
};

/** True for the failures after which "strong" hands the same messages to "main". */
function canFallBack(error: unknown): boolean {
  return (
    error instanceof ModelTimeout ||
    error instanceof RateLimited ||
    (error instanceof ModelHttpError && (error.status === undefined || error.status === 404 || error.status >= 500))
  );
}

async function callWithFallback(state: CallState, tier: Tier, user: string): Promise<Answered> {
  const { cfg } = state;
  if (tier !== "strong") {
    return { ...(await callTier(state, tier, user)), tier, fellBack: false, strongFailure: "" };
  }
  try {
    return { ...(await callTier(state, "strong", user)), tier, fellBack: false, strongFailure: "" };
  } catch (error) {
    if (!canFallBack(error) || cfg.models.main === undefined) throw error;
    const strongFailure = `strong failed (${error instanceof Error ? error.name : "error"})`;
    return { ...(await callTier(state, "main", user)), tier: "main", fellBack: true, strongFailure };
  }
}

/** `tail`: messages after the history, such as the correction a structured retry sends. */
async function callTier(state: CallState, tier: Tier, user: string, tail: HistoryMessage[] = []): Promise<{ message: ParsedMessage; requested: string }> {
  const { options, cfg } = state;
  const requested = cfg.models[tier];
  if (requested === undefined) throw new ConfigError(`NEMOTRON_MODEL_${SOURCE_TIERS[tier].toUpperCase()} is empty.`);

  const messages: HistoryMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: user },
    ...(options.history ?? []),
    ...tail,
  ];
  const response = await sendWithRetry(state, tier, requested, messages);

  const usage = response.usage;
  if (usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    state.usage = {
      tokens_in: (state.usage?.tokens_in ?? 0) + usage.prompt_tokens,
      tokens_out: (state.usage?.tokens_out ?? 0) + usage.completion_tokens,
    };
  }
  return { message: parseMessage(response), requested };
}

function parseMessage(response: OpenAI.Chat.Completions.ChatCompletion): ParsedMessage {
  const message = response.choices?.[0]?.message;
  // content empty with reasoning_content or reasoning set: the reply counts as empty.
  const text = typeof message?.content === "string" ? message.content : "";
  const rawCalls = (message?.tool_calls ?? []).filter((call) => call.type === "function");
  const toolCalls: ToolCallResult[] | undefined =
    rawCalls.length === 0
      ? undefined
      : rawCalls.map((call) => {
          const fn = (call as { id: string; function: { name: string; arguments: string } }).function;
          const parsed = parseArguments(fn.arguments);
          return parsed === null
            ? { id: call.id, name: fn.name, arguments: {}, error: "bad_arguments" as const }
            : { id: call.id, name: fn.name, arguments: parsed };
        });

  const receipt = (response as unknown as MeterlessReceipt).meterless;
  const routed = receipt?.routed_model;
  const cost = receipt?.cost?.actual_usd;
  return {
    text,
    toolCalls,
    reportedModel: typeof response.model === "string" && response.model !== "" ? response.model : undefined,
    routedModel: typeof routed === "string" && routed !== "" ? routed : undefined,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
  };
}

/** null when the arguments are not a JSON object. An empty string counts as no arguments. */
function parseArguments(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * True when the provider answered 502 with "empty_response": the model spent the token budget reasoning and
 * returned no content. Nightshift names it in the message, the error code, the type or the error body.
 */
function isEmptyResponse(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as ErrorLike & { type?: unknown; error?: unknown };
  if (e.status !== 502) return false;
  const fields = [e.message, e.code, e.type, e.error === undefined ? undefined : JSON.stringify(e.error)];
  return fields.some((field) => typeof field === "string" && /empty_response/i.test(field));
}

/** True for OpenRouter's host. Every other METERLESS_BASE_URL host is Nightshift (127.0.0.1:8088 by default). */
function isOpenRouter(host: string): boolean {
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

/**
 * Whether a request turns reasoning off: only the fast tier, and only on OpenRouter. Nightshift never gets the
 * switch on any tier: the owner's replays of 22 Oct showed its Nemotron lanes answer 502 empty_response every time
 * with reasoning { enabled: false }, and time out on the Analyst's request.
 */
function sendsReasoningOff(state: CallState, tier: Tier, requested: string): boolean {
  return tier === "fast" && isOpenRouter(state.host) && !noReasoningSwitch.has(requested);
}

function buildParams(
  state: CallState,
  tier: Tier,
  requested: string,
  messages: HistoryMessage[],
  maxTokens: number = state.cfg.MAX_COMPLETION_TOKENS,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const { cfg, options } = state;
  // max_tokens is deprecated in the SDK types in favour of max_completion_tokens; the spec names max_tokens.
  const params: Record<string, unknown> = {
    model: requested,
    messages,
    temperature: cfg.TEMPERATURE,
    max_tokens: maxTokens,
  };
  if (options.json === true && !noJsonMode.has(requested)) params.response_format = { type: "json_object" };
  if (options.tools !== undefined && options.tools.length > 0) {
    params.tools = options.tools;
    params.tool_choice = "auto";
  }
  if (sendsReasoningOff(state, tier, requested)) {
    // openai-node has no extra_body, so the switch goes into the params directly. chat_template_kwargs is never
    // sent: Nightshift does not pass it on, and OpenRouter takes reasoning { enabled: false }.
    params.reasoning = { enabled: false };
  }
  return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

/** Waits `ms`; rejects with the signal's reason as soon as `signal` aborts, so a stopped run does not sit in a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Throws BudgetExhaustedError("max_model_calls") when the next request would pass the caller's modelCallsLeft. */
function ensureModelCallLeft(state: CallState): void {
  const left = state.options.modelCallsLeft;
  if (left === undefined || state.attempts < left) return;
  throw new BudgetExhaustedError(
    "max_model_calls",
    `The run's model budget is spent: ${state.attempts} ${state.attempts === 1 ? "request" : "requests"} of this call used the last of it, so no retry was sent.`,
  );
}

/** The usage of a retry line: the failed request before it, counted as one model call. */
function countAttemptOnLine(state: CallState): { model_calls: number } {
  state.countedOnLines += 1;
  return { model_calls: 1 };
}

/** The requests not yet counted on a retry line: the final model_call line carries them. */
function uncounted(state: CallState): number {
  return Math.max(0, state.attempts - state.countedOnLines);
}

/** No retry is made with less than this left before the deadline: the retry would time out at once. */
const RETRY_FLOOR_MS = 1000;

/** The parsed reply, or the BadJson that says why it cannot be used: it does not parse, or `validate` refuses it. */
function structuralProblem(text: string, validate: CompleteOptions["validate"]): { json: Record<string, unknown>; error?: undefined } | { json?: undefined; error: BadJson } {
  let json: Record<string, unknown>;
  try {
    json = parseJsonReply(text);
  } catch (error) {
    if (error instanceof BadJson) return { error };
    throw error;
  }
  const reason = validate?.(json) ?? null;
  return reason === null ? { json } : { error: new BadJson(text, reason.slice(0, 300), "schema") };
}

/** The user message a structured retry adds: what was wrong, briefly, and the shape again. Code text, never reply text. */
function retryMessage(problem: BadJson, shape: string | undefined): string {
  const what = problem.kind === "schema" ? `Your last reply did not match the required shape: ${problem.reason}.` : `Your last reply could not be read as JSON: ${problem.reason}.`;
  return `${what} ${JSON_ONLY_SENTENCE}${shape === undefined ? "" : ` The shape: ${shape}`}`;
}

/**
 * Whether a structured retry may start: its prompt stays within MAX_PROMPT_CHARS, and with the round's end given, at
 * least MODEL_TIMEOUT_CAP_MS of the round is left (a whole call fits); without it, at least a second of this call's time.
 */
function structuredRetryFits(state: CallState, promptChars: number): boolean {
  if (promptChars > state.cfg.MAX_PROMPT_CHARS) return false;
  const roundEnd = state.options.roundDeadlineMs;
  return roundEnd === undefined ? timeLeftMs(state) >= RETRY_FLOOR_MS : roundEnd - Date.now() >= MODEL_TIMEOUT_CAP_MS;
}

/** With the round's end given, a retry gets a whole attempt again, inside the round; without it, the call's deadline stands. */
function renewDeadlineInRound(state: CallState, tier: Tier): void {
  const roundEnd = state.options.roundDeadlineMs;
  if (roundEnd === undefined) return;
  const tierTimeout = tier === "strong" ? state.cfg.MODEL_TIMEOUT_STRONG_MS : state.cfg.MODEL_TIMEOUT_MS;
  state.deadline = Date.now() + Math.min(tierTimeout, roundEnd - Date.now());
}

/** The time left before the caller's deadline; Infinity when the caller set none. */
function timeLeftMs(state: CallState): number {
  return state.deadline === undefined ? Infinity : state.deadline - Date.now();
}

function attemptTimeoutMs(state: CallState, tier: Tier): number {
  if (state.deadline !== undefined) {
    const left = state.deadline - Date.now();
    if (left <= 0) throw new ModelTimeout("The time left for this model call ran out.");
    return left;
  }
  return tier === "strong" ? state.cfg.MODEL_TIMEOUT_STRONG_MS : state.cfg.MODEL_TIMEOUT_MS;
}

async function sendWithRetry(
  state: CallState,
  tier: Tier,
  requested: string,
  messages: HistoryMessage[],
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { options, cfg } = state;
  let transportRetried = false;
  // Tries that ended in a 502 "empty_response", counted when the caller passed the round's end.
  let emptyTries = 0;
  // Raised for a retry after a 502 "empty_response": the same request with a larger token budget.
  let maxTokens = cfg.MAX_COMPLETION_TOKENS;
  for (;;) {
    const params = buildParams(state, tier, requested, messages, maxTokens);
    const timeout = attemptTimeoutMs(state, tier);
    ensureModelCallLeft(state);
    state.attempts += 1;
    try {
      return await state.client.chat.completions.create(params, { timeout, maxRetries: 0, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      // The run was stopped: the SDK throws APIUserAbortError. It is the owner's decision, not a failure to retry or fall back from.
      if (options.signal?.aborted) throw error;
      const failure = classify(error);
      const retryTrace = (why: string) =>
        options.tracer?.log({
          agent_name: options.agent,
          ...promptHashOf(options),
          action: "model_retry",
          input_summary: `${tier} model request`,
          output_summary: `${why}; trying once more (the failed request counted as a model call)`,
          status: "retry",
          usage: countAttemptOnLine(state),
          why,
          model: requested,
        });

      switch (failure.kind) {
        case "unauthorized":
          throw new Unauthorized(
            `Model call unauthorized (HTTP ${failure.status}): the Nightshift runtime token was rejected. Check METERLESS_API_KEY.`,
          );
        case "refused":
          throw new NightshiftNotRunning("Nightshift not running: start it and check METERLESS_BASE_URL");
        case "bad_request": {
          const dropped = dropRejectedParam(state, tier, requested, failure.message, sendsReasoningOff(state, tier, requested));
          if (dropped !== null) {
            state.retries += 1;
            continue;
          }
          throw new ModelHttpError(`The model API rejected the request (HTTP 400): ${scrub(failure.message, cfg)}`, 400);
        }
        case "not_found":
          throw new ModelHttpError(`Model "${requested}" or the endpoint was not found (HTTP 404).`, 404);
        case "timeout":
        case "rate_limit":
        case "server":
        case "network": {
          if (failure.kind === "server" && isEmptyResponse(error) && options.roundDeadlineMs !== undefined) {
            // The lane gives no answer about one time in two: up to EMPTY_RESPONSE_MAX_TRIES tries, each retry after
            // its wait, and only while a whole model call (MODEL_TIMEOUT_CAP_MS) still fits in the round after it.
            emptyTries += 1;
            const wait = EMPTY_RESPONSE_RETRY_WAITS_MS[emptyTries - 1];
            const roomAfterWait = wait === undefined ? 0 : options.roundDeadlineMs - Date.now() - wait;
            if (emptyTries < EMPTY_RESPONSE_MAX_TRIES && wait !== undefined && roomAfterWait >= MODEL_TIMEOUT_CAP_MS) {
              // No wait for a retry the run's model-call budget would refuse.
              ensureModelCallLeft(state);
              state.retries += 1;
              maxTokens = Math.max(cfg.MAX_COMPLETION_TOKENS, EMPTY_RESPONSE_RETRY_MAX_TOKENS);
              options.tracer?.log({
                agent_name: options.agent,
                ...promptHashOf(options),
                action: "empty_response_retry",
                input_summary: `${tier} model request`,
                output_summary: `HTTP 502 empty_response; try ${emptyTries + 1} of ${EMPTY_RESPONSE_MAX_TRIES} after ${wait / 1000} s, max_tokens ${maxTokens} (the empty reply counted as a model call)`,
                status: "retry",
                why: "the model returned no content (HTTP 502 empty_response)",
                model: requested,
                usage: countAttemptOnLine(state),
              });
              await sleep(wait, options.signal);
              // The retry gets a whole attempt again, inside the round.
              renewDeadlineInRound(state, tier);
              continue;
            }
            const tries = `${emptyTries} ${emptyTries === 1 ? "try" : "tries"} failed with HTTP 502 empty_response`;
            const reason =
              emptyTries >= EMPTY_RESPONSE_MAX_TRIES
                ? ""
                : `; under MODEL_TIMEOUT_CAP_MS (${MODEL_TIMEOUT_CAP_MS} ms) of the round was left for try ${emptyTries + 1} of ${EMPTY_RESPONSE_MAX_TRIES}`;
            throw new ModelHttpError(`The ${tier} model call failed: ${tries}${reason}: ${scrub(failure.message, cfg)}`, failure.status);
          }
          const why =
            failure.kind === "timeout" ? "timeout" : failure.kind === "network" ? "network error" : `HTTP ${failure.kind === "rate_limit" ? 429 : failure.status}`;
          // A timeout used the whole attempt, so the call's own deadline has passed. With the round's end given, it
          // gets its one retry as a whole new attempt when a whole model call (MODEL_TIMEOUT_CAP_MS) still fits in the round.
          if (failure.kind === "timeout" && !transportRetried && options.roundDeadlineMs !== undefined && options.roundDeadlineMs - Date.now() >= MODEL_TIMEOUT_CAP_MS) {
            transportRetried = true;
            state.retries += 1;
            retryTrace(why);
            await sleep(BACKOFF_MS, options.signal);
            renewDeadlineInRound(state, tier);
            continue;
          }
          // One retry, unless the caller's deadline leaves under a second: that retry would only time out.
          if (!transportRetried && timeLeftMs(state) >= RETRY_FLOOR_MS) {
            transportRetried = true;
            state.retries += 1;
            // A 502 "empty_response": the model returned no content. The one retry is the same request (reasoning
            // left as it was) with max_tokens raised to EMPTY_RESPONSE_RETRY_MAX_TOKENS.
            if (isEmptyResponse(error)) {
              maxTokens = Math.max(cfg.MAX_COMPLETION_TOKENS, EMPTY_RESPONSE_RETRY_MAX_TOKENS);
              options.tracer?.log({
                agent_name: options.agent,
                ...promptHashOf(options),
                action: "empty_response_retry",
                input_summary: `${tier} model request`,
                output_summary: `HTTP 502 empty_response; trying once more with max_tokens ${maxTokens} (the empty reply counted as a model call)`,
                status: "retry",
                why: "the model returned no content (HTTP 502 empty_response)",
                model: requested,
                usage: countAttemptOnLine(state),
              });
              await sleep(BACKOFF_MS, options.signal);
              continue;
            }
            retryTrace(why);
            await sleep(BACKOFF_MS, options.signal);
            continue;
          }
          const times = transportRetried ? "twice" : "once, with no time left for a retry";
          if (failure.kind === "timeout") throw new ModelTimeout(`The ${tier} model call timed out ${times} (${timeout} ms at most for the attempt).`);
          if (failure.kind === "rate_limit") throw new RateLimited(`The ${tier} model call was rate limited (HTTP 429) ${times}.`);
          throw new ModelHttpError(
            `The ${tier} model call failed ${times}: ${scrub(failure.message, cfg)}`,
            failure.kind === "server" ? failure.status : undefined,
          );
        }
        default:
          throw new ModelHttpError(`The model call failed: ${scrub(failure.message, cfg)}`, failure.status);
      }
    }
  }
}

/**
 * A 400 that names an optional request field: remember the rejection for this model id, trace it once, and
 * report which field to leave out on the resend. Returns null when the 400 is about something else.
 */
function dropRejectedParam(state: CallState, tier: Tier, requested: string, message: string, sentReasoningOff: boolean): string | null {
  const { options } = state;
  if (options.json === true && !noJsonMode.has(requested) && /response_format/i.test(message)) {
    noJsonMode.add(requested);
    options.tracer?.log({
      agent_name: options.agent,
      ...promptHashOf(options),
      action: "json_mode_unsupported",
      input_summary: `${tier} model request with response_format json_object`,
      output_summary: "the API rejected response_format; resent without it (the rejected request counted as a model call)",
      status: "retry",
      usage: countAttemptOnLine(state),
      why: "response_format rejected with HTTP 400",
      model: requested,
    });
    return "response_format";
  }
  if (sentReasoningOff && /chat_template_kwargs|enable_thinking|reasoning/i.test(message)) {
    noReasoningSwitch.add(requested);
    options.tracer?.log({
      agent_name: options.agent,
      ...promptHashOf(options),
      action: "reasoning_switch_unsupported",
      input_summary: `${tier} model request with the reasoning switch off`,
      output_summary: "the API rejected the reasoning switch; resent without it (the rejected request counted as a model call)",
      status: "retry",
      usage: countAttemptOnLine(state),
      why: "reasoning switch rejected with HTTP 400",
      model: requested,
    });
    return "reasoning";
  }
  return null;
}
