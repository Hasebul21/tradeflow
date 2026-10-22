// The one place that calls a model. Every call goes to the OpenAI-compatible endpoint in METERLESS_BASE_URL
// (Meterless Nightshift), or to sample-model.ts in sample mode. Server only: the key never leaves this module.
//
// openai-node retries by itself (maxRetries 2 by default). It is switched off here (maxRetries 0) so the retry
// count, the backoff and the trace lines are ours, and so one call makes at most the requests this file counts.
import OpenAI from "openai";
import { ConfigError, loadConfig, type Config, type Tier } from "./config";
import { complete as completeWithSampleModel } from "./sample-model";
import type { Tracer, TraceInput } from "./trace";

export type AgentName = "Planner" | "Analyst" | "Evaluator" | "Writer" | "Memory";

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
  tracer?: Pick<Tracer, "log">;
  /** Default loadConfig(). */
  config?: Config;
  /** Default config.sampleMode. */
  sampleMode?: boolean;
  /** The time left for this call; the orchestrator passes it. Default: the tier's timeout from config. */
  timeoutMs?: number;
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
};

// ---------------------------------------------------------------------------------------------------------------
// Typed errors. None of the messages holds the key.

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class PromptTooLarge extends ModelError {}
export class BadJson extends ModelError {
  /** The first 200 characters of the reply. */
  readonly reply: string;
  constructor(reply: string) {
    const excerpt = reply.slice(0, 200);
    super(`The model reply is not a JSON object. Start of the reply: ${JSON.stringify(excerpt)}`);
    this.reply = excerpt;
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

/** Removes <think> blocks and Markdown fences, then parses from the first "{" to the last "}". Throws BadJson. */
export function parseJsonReply(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```[A-Za-z0-9_-]*/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new BadJson(text);
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through to BadJson
  }
  throw new BadJson(text);
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
  usage: { tokens_in: number; tokens_out: number } | null;
};

type MeterlessReceipt = { meterless?: { routed_model?: unknown; cost?: { actual_usd?: unknown } } };

export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const cfg = options.config ?? loadConfig();
  const sampleMode = options.sampleMode ?? cfg.sampleMode;
  const started = Date.now();
  // The history (earlier tool calls and their results) is part of the prompt, so it counts toward the limit.
  const historyChars = (options.history ?? []).reduce((n, message) => n + (JSON.stringify(message)?.length ?? 0), 0);
  const promptChars = options.system.length + options.user.length + historyChars;
  const baseLine = (): Pick<TraceInput, "agent_name" | "action" | "input_summary"> => ({
    agent_name: options.agent,
    action: "model_call",
    input_summary: `${options.model} model, json=${options.json === true}, ${promptChars} prompt chars`,
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
    const result = await completeWithSampleModel(options);
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
    if (answered.message.toolCalls === undefined && options.json === true) {
      try {
        json = parseJsonReply(answered.message.text);
      } catch (first) {
        if (!(first instanceof BadJson)) throw first;
        // With under a second left there is no time for another request: the first error stands.
        if (timeLeftMs(state) < RETRY_FLOOR_MS) throw first;
        state.retries += 1;
        options.tracer?.log({
          ...baseLine(),
          action: "model_retry",
          output_summary: "the reply is empty or not JSON; asking once more",
          status: "retry",
          why: "unparseable JSON reply",
          model: answered.requested,
        });
        // The retry stays on the model that answered: no second fallback.
        const again = await callTier(state, answered.tier, `${options.user}\n\n${JSON_ONLY_SENTENCE}`);
        answered = { ...answered, message: again.message };
        json = parseJsonReply(again.message.text);
      }
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
      usage: { ...(state.usage === null ? {} : { tokens_in: state.usage.tokens_in, tokens_out: state.usage.tokens_out }), model_calls: 1 },
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
    options.tracer?.log({
      ...baseLine(),
      output_summary: `${error instanceof Error ? error.name : "Error"}: ${scrub(error instanceof Error ? error.message : String(error), cfg)}`,
      status: "error",
      why: error instanceof ModelError ? error.name : "unexpected error",
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

async function callTier(state: CallState, tier: Tier, user: string): Promise<{ message: ParsedMessage; requested: string }> {
  const { options, cfg } = state;
  const requested = cfg.models[tier];
  if (requested === undefined) throw new ConfigError(`NEMOTRON_MODEL_${SOURCE_TIERS[tier].toUpperCase()} is empty.`);

  const messages: HistoryMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: user },
    ...(options.history ?? []),
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

function buildParams(
  state: CallState,
  tier: Tier,
  requested: string,
  messages: HistoryMessage[],
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const { cfg, options } = state;
  // max_tokens is deprecated in the SDK types in favour of max_completion_tokens; the spec names max_tokens.
  const params: Record<string, unknown> = {
    model: requested,
    messages,
    temperature: cfg.TEMPERATURE,
    max_tokens: cfg.MAX_COMPLETION_TOKENS,
  };
  if (options.json === true && !noJsonMode.has(requested)) params.response_format = { type: "json_object" };
  if (options.tools !== undefined && options.tools.length > 0) {
    params.tools = options.tools;
    params.tool_choice = "auto";
  }
  if (tier === "fast" && !noReasoningSwitch.has(requested)) {
    // openai-node has no extra_body, so the switch goes into the params directly.
    if (state.host === "openrouter.ai") params.reasoning = { enabled: false };
    else params.chat_template_kwargs = { enable_thinking: false };
  }
  return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** No retry is made with less than this left before the deadline: the retry would time out at once. */
const RETRY_FLOOR_MS = 1000;

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
  for (;;) {
    const params = buildParams(state, tier, requested, messages);
    const timeout = attemptTimeoutMs(state, tier);
    try {
      return await state.client.chat.completions.create(params, { timeout, maxRetries: 0 });
    } catch (error) {
      const failure = classify(error);
      const retryTrace = (why: string) =>
        options.tracer?.log({
          agent_name: options.agent,
          action: "model_retry",
          input_summary: `${tier} model request`,
          output_summary: `${why}; trying once more`,
          status: "retry",
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
          const dropped = dropRejectedParam(state, tier, requested, failure.message);
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
          const why =
            failure.kind === "timeout" ? "timeout" : failure.kind === "network" ? "network error" : `HTTP ${failure.kind === "rate_limit" ? 429 : failure.status}`;
          // One retry, unless the caller's deadline leaves under a second: that retry would only time out.
          if (!transportRetried && timeLeftMs(state) >= RETRY_FLOOR_MS) {
            transportRetried = true;
            state.retries += 1;
            retryTrace(why);
            await sleep(BACKOFF_MS);
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
function dropRejectedParam(state: CallState, tier: Tier, requested: string, message: string): string | null {
  const { options } = state;
  if (options.json === true && !noJsonMode.has(requested) && /response_format/i.test(message)) {
    noJsonMode.add(requested);
    options.tracer?.log({
      agent_name: options.agent,
      action: "json_mode_unsupported",
      input_summary: `${tier} model request with response_format json_object`,
      output_summary: "the API rejected response_format; resent without it",
      status: "retry",
      why: "response_format rejected with HTTP 400",
      model: requested,
    });
    return "response_format";
  }
  if (tier === "fast" && !noReasoningSwitch.has(requested) && /chat_template_kwargs|enable_thinking|reasoning/i.test(message)) {
    noReasoningSwitch.add(requested);
    options.tracer?.log({
      agent_name: options.agent,
      action: "reasoning_switch_unsupported",
      input_summary: `${tier} model request with the reasoning switch off`,
      output_summary: "the API rejected the reasoning switch; resent without it",
      status: "retry",
      why: "reasoning switch rejected with HTTP 400",
      model: requested,
    });
    return "reasoning";
  }
  return null;
}
