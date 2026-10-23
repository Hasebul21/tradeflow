// The Planner: picks at most MAX_PLAN_STEPS named queries for an open task (explain_week, thesis_check), with a why
// for each. It never runs a query and never answers the owner. The system prompt is prompts/planner.md as-is; the
// user message is one JSON object (rule 7: data goes to the model as JSON, never into the system prompt). Each
// step's query_id is checked against the task's catalogue and its params against that query's schema; an invalid
// step is dropped and traced, never run. Server only (node:fs reads the prompt).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type Config } from "../config";
import { catalogueFor, memoriesForModel, type MemoryForModel, type Task } from "../context";
import { afterModel } from "../guards";
import { complete as completeModel, type CompleteOptions, type CompleteResult } from "../llm";
import type { RecalledMemory } from "../memory";
import { QUERIES, isQueryId, type CatalogueEntry, type QueryId } from "../queries";
import type { Tracer } from "../trace";

const AGENT = "Planner";
const TARGET = "Analyst";
const WHY_CHARS = 200;
const SUMMARY_CHARS = 200;
const PROMPT_FILE = path.resolve(process.cwd(), "src/agent/prompts/planner.md");

export type PlannerTrade = { symbol: string; side: "buy" | "sell"; quantity: number; price?: number };

/** What the orchestrator hands the Planner. Memories are trimmed and the catalogue is built here. */
export type PlanRequest = {
  task: Task;
  question: string;
  as_of: string;
  trade?: PlannerTrade | null;
  memories?: readonly RecalledMemory[];
  /** World Model facts about the holdings involved; an empty list until src/agent/world.ts exists. */
  world?: readonly unknown[];
  /** Rounds 2 and 3: what the Evaluator rejected and the fix it asked for. */
  feedback?: string | null;
};

/** The user message, exactly as the model sees it. */
export type PlannerInput = {
  task: Task;
  question: string;
  as_of: string;
  trade: PlannerTrade | null;
  memories: MemoryForModel[];
  world: unknown[];
  catalogue: CatalogueEntry[];
  feedback: string | null;
};

export type PlanDeps = {
  tracer: Tracer;
  config?: Config;
  sampleMode?: boolean;
  /** The time left in the run for this call. */
  timeoutMs?: number;
  /** When the round ends; passed on to llm.ts for its empty_response retries. */
  roundDeadlineMs?: number;
  /** The run's cancel signal; it goes to every model call this agent makes. */
  signal?: AbortSignal;
  /** The model calls left in the run's budget; passed on to llm.ts, which sends no request past it. */
  modelCallsLeft?: number;
  /** The loop round, 0 in the first; written as retry_count on the trace lines. */
  round?: number;
  /** For tests: a stand-in for llm.ts's complete. */
  complete?: (options: CompleteOptions) => Promise<CompleteResult>;
};

export type PlannedStep = { query_id: QueryId; params: Record<string, unknown>; why: string };
export type DroppedStep = { index: number; query_id: string | null; reason: string };

export type PlanOutcome = {
  focus: string;
  steps: PlannedStep[];
  declined_advice: boolean;
  injection_seen: boolean;
  /** The steps that never run, with the reason, in reply order. */
  dropped: DroppedStep[];
  /** Valid steps removed beyond MAX_PLAN_STEPS. */
  cut: number;
  model: {
    model_id: string;
    source: CompleteResult["source"];
    usage: CompleteResult["usage"];
    duration_ms: number;
    fallback?: CompleteResult["fallback"];
    /** The requests the call made, retries included; each counts as one model call. */
    model_calls?: number;
  };
};

/** guards.afterModel refused the plan: its wording tells the owner what to trade. Nothing of it is used. */
export class PlanBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PlanBlockedError";
  }
}

// The reply the prompt defines. The envelope is lenient so a reply with a bad field still yields its valid steps;
// each step is checked on its own.
export const planStepSchema = z.object({
  query_id: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  why: z.string().trim().min(1),
});
export const planReplySchema = z.object({
  focus: z.string().catch(""),
  steps: z.array(z.unknown()).catch([]),
  declined_advice: z.boolean().catch(false),
  injection_seen: z.boolean().catch(false),
});

let promptCache: string | undefined;

/** prompts/planner.md as-is, read once. */
export function plannerPrompt(): string {
  promptCache ??= readFileSync(PROMPT_FILE, "utf8");
  return promptCache;
}

const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unreadable]";
  }
};

/** Builds the user message: trimmed memories, the task's catalogue, world facts (empty until world.ts exists). */
export function plannerInput(request: PlanRequest, config?: Config): PlannerInput {
  const max = config?.MAX_MEMORIES;
  return {
    task: request.task,
    question: request.question,
    as_of: request.as_of,
    trade: request.trade ?? null,
    memories: max === undefined ? memoriesForModel(request.memories ?? []) : memoriesForModel(request.memories ?? [], max),
    world: [...(request.world ?? [])],
    catalogue: catalogueFor(request.task),
    feedback: request.feedback ?? null,
  };
}

type Checked = { ok: true; step: PlannedStep } | { ok: false; dropped: DroppedStep };

/** One step against the catalogue and its query's schema. The kept params are the parsed ones, defaults filled. */
function checkStep(raw: unknown, index: number, allowed: ReadonlySet<string>): Checked {
  const parsed = planStepSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const id = raw !== null && typeof raw === "object" && typeof (raw as { query_id?: unknown }).query_id === "string" ? (raw as { query_id: string }).query_id : null;
    return { ok: false, dropped: { index, query_id: id, reason: `the step does not match the step schema (${issue.path.join(".") || "step"}: ${issue.message})` } };
  }
  const { query_id, params, why } = parsed.data;
  if (!allowed.has(query_id) || !isQueryId(query_id)) {
    return { ok: false, dropped: { index, query_id, reason: `${query_id} is not in the task's catalogue` } };
  }
  const checked = QUERIES[query_id].params.safeParse(params);
  if (!checked.success) {
    const detail = checked.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ");
    return { ok: false, dropped: { index, query_id, reason: `params do not match the schema of ${query_id} (${detail})` } };
  }
  return { ok: true, step: { query_id, params: checked.data as Record<string, unknown>, why: why.slice(0, WHY_CHARS) } };
}

/**
 * Plans the queries for one task: the strong model (llm.ts falls back to main), the reply validated step by step,
 * invalid steps dropped and traced, then at most MAX_PLAN_STEPS kept, then guards.afterModel on the plan that is
 * used. One trace line per planned step carries its why and target_agent "Analyst". Throws PlanBlockedError when
 * the guard refuses the plan; model errors from llm.ts pass through.
 */
export async function plan(request: PlanRequest, deps: PlanDeps): Promise<PlanOutcome> {
  const cfg = deps.config ?? loadConfig(process.env, () => {});
  const tracer = deps.tracer;
  const round = deps.round ?? 0;
  const started = Date.now();
  const input = plannerInput(request, cfg);
  const inputSummary = capped(
    `task=${input.task} as_of=${input.as_of} question ${input.question.length} chars, ${input.memories.length} memories, ${input.world.length} world facts, ${input.catalogue.length} queries, feedback=${input.feedback === null ? "none" : `${input.feedback.length} chars`}`,
  );

  const result = await (deps.complete ?? completeModel)({
    system: plannerPrompt(),
    user: JSON.stringify(input),
    model: "strong",
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

  const raw = result.json ?? {};
  const reply = planReplySchema.parse(raw);
  if (!Array.isArray((raw as { steps?: unknown }).steps)) {
    tracer.log({
      agent_name: AGENT,
      action: "reply_without_steps",
      input_summary: inputSummary,
      output_summary: "the reply has no steps array; nothing is planned",
      status: "rejected",
      why: "the reply has no steps array",
      model: result.model_id,
      retry_count: round,
    });
  }

  // Drop invalid steps first, then cut to the limit, so a bad step never takes a valid one's place.
  const allowed = new Set(input.catalogue.map((entry) => entry.id));
  const kept: PlannedStep[] = [];
  const dropped: DroppedStep[] = [];
  reply.steps.forEach((step, index) => {
    const checked = checkStep(step, index, allowed);
    if (checked.ok) {
      kept.push(checked.step);
      return;
    }
    dropped.push(checked.dropped);
    tracer.log({
      agent_name: AGENT,
      action: "step_dropped",
      input_summary: capped(`step ${index + 1}: ${safeJson(step)}`),
      output_summary: capped(`dropped, never run: ${checked.dropped.reason}`),
      status: "rejected",
      why: checked.dropped.reason,
      model: result.model_id,
      retry_count: round,
    });
  });

  const max = cfg.MAX_PLAN_STEPS;
  const steps = kept.slice(0, max);
  const cut = kept.length - steps.length;
  if (cut > 0) {
    tracer.log({
      agent_name: AGENT,
      action: "plan_cut",
      input_summary: `${kept.length} valid steps`,
      output_summary: capped(`kept the first ${max}; cut ${kept.slice(max).map((step) => step.query_id).join(", ")}`),
      status: "ok",
      why: `more than MAX_PLAN_STEPS (${max}) steps`,
      model: result.model_id,
      retry_count: round,
    });
  }

  const plan = { focus: reply.focus, steps, declined_advice: reply.declined_advice, injection_seen: reply.injection_seen };
  const guard = afterModel(AGENT, plan, input, tracer);
  if (!guard.ok) {
    tracer.log({
      agent_name: AGENT,
      action: "plan",
      input_summary: inputSummary,
      output_summary: capped(`blocked: ${guard.reason}`),
      status: "blocked",
      why: guard.reason,
      model: result.model_id,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    throw new PlanBlockedError(guard.reason);
  }

  steps.forEach((step, index) => {
    tracer.log({
      agent_name: AGENT,
      action: "plan_step",
      input_summary: `step ${index + 1} of ${steps.length}`,
      output_summary: capped(`${step.query_id} ${safeJson(step.params)}`),
      target_agent: TARGET,
      status: "ok",
      why: step.why,
      model: result.model_id,
      retry_count: round,
    });
  });

  const outcome: PlanOutcome = {
    ...plan,
    injection_seen: plan.injection_seen || guard.injection_seen,
    dropped,
    cut,
    model: {
      model_id: result.model_id,
      source: result.source,
      usage: result.usage,
      duration_ms: result.duration_ms,
      ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
      ...(result.model_calls === undefined ? {} : { model_calls: result.model_calls }),
    },
  };
  tracer.log({
    agent_name: AGENT,
    action: "plan",
    input_summary: inputSummary,
    output_summary: capped(
      `${steps.length} steps: ${steps.map((step) => step.query_id).join(", ") || "none"}; ${dropped.length} dropped, ${cut} cut; declined_advice=${outcome.declined_advice}, injection_seen=${outcome.injection_seen}; focus: ${outcome.focus}`,
    ),
    target_agent: TARGET,
    status: "ok",
    model: result.model_id,
    retry_count: round,
    duration_ms: Date.now() - started,
  });
  return outcome;
}
