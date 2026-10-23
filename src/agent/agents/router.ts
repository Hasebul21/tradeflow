// The Router: reads the owner's free question and names the task that fits (explain_week, thesis_check, pre_trade or
// reconcile), with the trade for a pre_trade. It never answers the question and never runs a query. The orchestrator
// calls it only when a request has no task. The system prompt is prompts/router.md as-is; the user message is one JSON
// object (rule 7: the question is data, never part of a system prompt). A reply that fails its schema, or an
// unparseable one after llm.ts's retry, routes to explain_week and is traced; it never ends the run. Code, not the
// model, decides whether a pre_trade is allowed: it needs a number in the question or a plan_id. Server only (node:fs
// reads the prompt).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type Config } from "../config";
import { TASKS, type Task } from "../context";
import { afterModel } from "../guards";
import { BadJson, complete as completeModel, failedCallUsage, type CompleteOptions, type CompleteResult, type FailedCallUsage } from "../llm";
import type { Tracer } from "../trace";
import type { PlannerTrade } from "./planner";

const AGENT = "Router";
const SUMMARY_CHARS = 200;
const PROMPT_FILE = path.resolve(process.cwd(), "src/agent/prompts/router.md");

/** What the Router is told about each task it may pick. */
const TASK_DESCRIPTIONS: Record<Task, string> = {
  explain_week: "Why the portfolio and its holdings moved in the week, with the rules the week broke.",
  thesis_check: "Whether the evidence still supports the owner's own journal theses.",
  pre_trade: "What a proposed trade, with a symbol, a side and a whole-share quantity, would do to the weights and the rules.",
  reconcile: "Where the broker and bank files differ from the ledger.",
};

export type RouterInstrument = { symbol: string; name: string };

/** What the orchestrator hands the Router. */
export type RouteRequest = {
  question: string;
  /** An open trade plan the owner named in the request, or null. */
  plan_id?: string | null;
  /** The instruments the ledger knows, so the model can map a name to a trading code. */
  instruments: readonly RouterInstrument[];
};

/** The user message, exactly as the model sees it: the question, the plan id, the instruments and the tasks. */
export type RouterInput = {
  question: string;
  plan_id: string | null;
  symbols: RouterInstrument[];
  tasks: { id: Task; description: string }[];
};

export type RouteDeps = {
  tracer: Tracer;
  config?: Config;
  sampleMode?: boolean;
  /** The time left in the run for this call. */
  timeoutMs?: number;
  roundDeadlineMs?: number;
  /** The run's cancel signal; it goes to every model call this agent makes. */
  signal?: AbortSignal;
  /** The model calls left in the run's budget; passed on to llm.ts. */
  modelCallsLeft?: number;
  /** For tests: a stand-in for llm.ts's complete. */
  complete?: (options: CompleteOptions) => Promise<CompleteResult>;
};

export type RoutedTrade = Pick<PlannerTrade, "symbol" | "side" | "quantity">;

export type RouteOutcome = {
  task: Task;
  /** Only for pre_trade built from the question; null for every other task and for a plan_id. */
  trade: RoutedTrade | null;
  /** The request's plan_id when the routed task is pre_trade and the request named one; otherwise null. */
  plan_id: string | null;
  /** The one-sentence reason written on the trace line. */
  why: string;
  /** True when the model's reply was not used and the route is explain_week. */
  fallback: boolean;
  /** The call's usage; null when the call failed (see `failed`). */
  model: { model_id: string; source: CompleteResult["source"]; usage: CompleteResult["usage"]; duration_ms: number; model_calls?: number } | null;
  /** What a failed call spent (an unparseable reply after llm.ts's retry); null when the call returned. */
  failed: FailedCallUsage | null;
};

// The reply the prompt defines. A bad value is not repaired: the whole reply is replaced by explain_week.
export const routerReplySchema = z.object({
  task: z.enum(TASKS as [Task, ...Task[]]),
  trade: z
    .object({
      symbol: z.string().trim().min(1),
      side: z.enum(["buy", "sell"]),
      quantity: z.number(),
    })
    .nullish(),
  plan_id: z.string().nullish(),
});

let promptCache: string | undefined;

/** prompts/router.md as-is, read once. */
export function routerPrompt(): string {
  promptCache ??= readFileSync(PROMPT_FILE, "utf8");
  return promptCache;
}

const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);

/** The user message. The question is the owner's text, boxed as a JSON string. */
export function routerInput(request: RouteRequest): RouterInput {
  return {
    question: request.question,
    plan_id: request.plan_id ?? null,
    symbols: request.instruments.map(({ symbol, name }) => ({ symbol, name })),
    tasks: TASKS.map((id) => ({ id, description: TASK_DESCRIPTIONS[id] })),
  };
}

/** A number the owner typed: a pre_trade without one, and without a plan_id, is not a trade to check. */
const holdsNumber = (question: string): boolean => /\d/.test(question);

/**
 * Routes one free question. The fast model replies; code then accepts the reply or replaces it with explain_week:
 * "invalid router reply" for a reply that fails the schema, that is not JSON, or that names pre_trade with nothing to
 * preview, and "no quantity" for a pre_trade the question and the request give no number or plan_id for. One
 * trace line, agent "Router", action "route", carries the task and the why. Model errors other than an unparseable
 * reply (a timeout, a 429, a refused connection) pass through, for the orchestrator's error reply.
 */
export async function route(request: RouteRequest, deps: RouteDeps): Promise<RouteOutcome> {
  const cfg = deps.config ?? loadConfig(process.env, () => {});
  const tracer = deps.tracer;
  const started = Date.now();
  const input = routerInput(request);
  const inputSummary = capped(`question ${input.question.length} chars, plan_id=${input.plan_id ?? "none"}, ${input.symbols.length} instruments`);

  let result: CompleteResult | null = null;
  let failed: FailedCallUsage | null = null;
  try {
    result = await (deps.complete ?? completeModel)({
      system: routerPrompt(),
      user: JSON.stringify(input),
      model: "fast",
      json: true,
      agent: AGENT,
      tracer,
      config: cfg,
      ...(deps.sampleMode === undefined ? {} : { sampleMode: deps.sampleMode }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.roundDeadlineMs === undefined ? {} : { roundDeadlineMs: deps.roundDeadlineMs }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.modelCallsLeft === undefined ? {} : { modelCallsLeft: deps.modelCallsLeft }),
    });
  } catch (error) {
    if (!(error instanceof BadJson)) throw error;
    failed = failedCallUsage(error);
  }

  const done = (task: Task, why: string, parts: { trade?: RoutedTrade | null; plan_id?: string | null; fallback?: boolean }): RouteOutcome => {
    const outcome: RouteOutcome = {
      task,
      trade: parts.trade ?? null,
      plan_id: parts.plan_id ?? null,
      why,
      fallback: parts.fallback ?? false,
      model:
        result === null
          ? null
          : { model_id: result.model_id, source: result.source, usage: result.usage, duration_ms: result.duration_ms, ...(result.model_calls === undefined ? {} : { model_calls: result.model_calls }) },
      failed,
    };
    tracer.log({
      agent_name: AGENT,
      action: "route",
      input_summary: inputSummary,
      output_summary: capped(
        `task=${task}${outcome.trade === null ? "" : ` trade=${outcome.trade.side} ${outcome.trade.quantity} ${outcome.trade.symbol}`}${outcome.plan_id === null ? "" : ` plan_id=${outcome.plan_id}`}${outcome.fallback ? " (fallback)" : ""}`,
      ),
      target_agent: null,
      status: outcome.fallback ? "fallback" : "ok",
      why,
      ...(result === null ? {} : { model: result.model_id }),
      duration_ms: Date.now() - started,
    });
    return outcome;
  };

  if (result === null) return done("explain_week", "invalid router reply", { fallback: true });

  const parsed = routerReplySchema.safeParse(result.json ?? {});
  if (!parsed.success) return done("explain_week", "invalid router reply", { fallback: true });
  const reply = parsed.data;

  // The same guard every model reply goes through: no advice wording, and the injection flag.
  const guard = afterModel(AGENT, reply, input, tracer);
  if (!guard.ok) return done("explain_week", "invalid router reply", { fallback: true });

  if (reply.task !== "pre_trade") {
    const why = reply.task === "explain_week" ? "explain_week: the question is about the week, or it fits no other task" : `${reply.task}: the question fits this task`;
    return done(reply.task, why, {});
  }

  // pre_trade is accepted only with something to preview, and only when the question holds a number or a plan is named.
  const planId = request.plan_id ?? null;
  if (planId === null && !holdsNumber(request.question)) return done("explain_week", "no quantity", { fallback: true });
  if (planId !== null) return done("pre_trade", `pre_trade: the request names plan ${planId}`, { plan_id: planId });
  if (reply.trade == null) return done("explain_week", "invalid router reply", { fallback: true });
  return done("pre_trade", "pre_trade: the question names a symbol, a side and a quantity", { trade: { symbol: reply.trade.symbol, side: reply.trade.side, quantity: reply.trade.quantity } });
}
