// The Analyst: turns the plan's query results into findings that cite a run_query_id for every number. Code runs
// every query: the planned steps in plan order through the run's cache and queries.runQuery (guards.beforeQuery
// first), then one call to the main model with prompts/analyst.md as-is and one JSON user message (rule 7). The
// model gets the task's named queries as native tools; a tool call is run by code the same way, its result goes
// back as a tool message, and the model is called again, at most MAX_TOOL_ROUNDS times, then once without tools.
// The model never writes SQL and never runs anything. The reply is validated with zod and goes through
// guards.afterModel; a bad or refused reply is a structured error, never a crash. Server only (node:fs).
import { z } from "zod";
import type { Config } from "../config";
import { catalogueFor, forModel, memoriesForModel, type MemoryForModel, type ResultForModel, type Task } from "../context";
import { afterModel, findingSchema, type Finding } from "../guards";
import { complete as completeModel, failedCallUsage, schemaReason, type CompleteOptions, type CompleteResult, type HistoryMessage, type ToolCallResult, type ToolSpec } from "../llm";
import { promptVersion, type PromptVersion } from "../prompts";
import type { RecalledMemory } from "../memory";
import { isQueryId, QueryBlockedError, QueryError, type QueryResult } from "../queries";
import type { RunState } from "../run-state";
import type { TraceStatus } from "../trace";
import type { PlannedStep, PlannerTrade } from "./planner";
import type { ThesisEvidence } from "../thesis";
import type { Retraction } from "../revision";

const AGENT = "Analyst";
const TARGET = "Evaluator";
const QUERY_AGENT = "Query";
const SUMMARY_CHARS = 200;

export const FINDING_KINDS = ["move", "sector", "announcement", "fundamentals", "dividend", "rule", "thesis", "pre_trade", "reconciliation"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
const THESIS_VERDICTS = ["confirmed", "contradicted", "open"] as const;

// The reply the prompt defines. A finding is the guard's finding (a non-empty subject, a cites list) with the kind
// as one of the nine, the verdict as one of the three or null, and the lists that a model may leave out read as
// empty, which claims nothing. The numbers list may be empty.
export const analystFindingSchema = findingSchema.extend({
  kind: z.enum(FINDING_KINDS),
  numbers: z.array(z.object({ value: z.number().finite(), label: z.string() })).default([]),
  cites: z.array(z.string()).default([]),
  verdict: z.enum(THESIS_VERDICTS).nullable().default(null),
  proposed_fix: z.string().nullable().default(null),
  memory_ids: z.array(z.string()).default([]),
});
/** A previous finding the Analyst withdraws on purpose; code carries every other unflagged one into the new draft. */
export const retractionSchema = z.object({ kind: z.string().min(1), subject: z.string().min(1), why: z.string().default("") });
export const analystReplySchema = z.object({
  findings: z.array(analystFindingSchema),
  gaps: z.array(z.string()).default([]),
  // A model that writes "retracted": null means none.
  retracted: z
    .array(retractionSchema)
    .nullish()
    .transform((value) => value ?? []),
});
export type AnalystReply = z.infer<typeof analystReplySchema>;

/** The reply's shape as prompts/analyst.md gives it, restated by llm.ts when it asks again after a bad reply. */
export const ANALYST_REPLY_SHAPE =
  '{"findings": [{"kind": "move", "subject": "<symbol, sector, PORTFOLIO, journal id, plan id or issue id>", "claim": "...", "numbers": [{"value": 0, "label": "..."}], "cites": ["<run_query_id>"], "verdict": null, "proposed_fix": null, "memory_ids": []}], "gaps": ["..."], "retracted": []}';

/**
 * The room a structured retry's correction takes (llm.ts retryMessage): a reason of at most 300 characters, three
 * short fixed sentences and this reply shape. The Analyst keeps it free when it adds previous findings' results.
 */
export const RETRY_NOTE_CHARS = ANALYST_REPLY_SHAPE.length + 500;

/**
 * A tool call's history beyond its rows: the tool message's run_query_id, query_id, params, row_count, truncated and
 * wrapper, and the assistant message that asked for the call (its id, name and arguments).
 */
const TOOL_ENVELOPE_CHARS = 600;

/**
 * The room tool rounds can take in the prompt, sized for real results: every round (MAX_TOOL_ROUNDS) running every
 * call it may (MAX_TOOL_CALLS_PER_ROUND), each returning a full MAX_ROWS_PER_QUERY rows as long as the longest row
 * this run holds, measured as the tool message carries it (a JSON string inside JSON, so every quote is escaped).
 * Used only to decide whether a previous finding's results fit; it never cuts a prompt.
 */
export function toolReserveChars(cfg: Pick<Config, "MAX_TOOL_ROUNDS" | "MAX_TOOL_CALLS_PER_ROUND" | "MAX_ROWS_PER_QUERY">, store: Record<string, QueryResult>): number {
  let rowChars = 0;
  for (const result of Object.values(store)) for (const row of result.rows) rowChars = Math.max(rowChars, JSON.stringify(JSON.stringify(row)).length);
  return cfg.MAX_TOOL_ROUNDS * cfg.MAX_TOOL_CALLS_PER_ROUND * (cfg.MAX_ROWS_PER_QUERY * rowChars + TOOL_ENVELOPE_CHARS);
}

/** Why a parsed reply fails the Analyst schema (the first issue), or null; llm.ts asks again with it. */
export function analystReplyProblem(json: Record<string, unknown>): string | null {
  const parsed = analystReplySchema.safeParse(json);
  if (parsed.success) return null;
  return schemaReason(parsed.error.issues[0]);
}

/**
 * A previous finding the fix flags: the number the fix gives it (counting the whole draft from 1, every thesis batch
 * included, so it can differ from its place in previous_findings), and the kind and subject to find it by.
 */
export type FlaggedFinding = { finding: number; kind: string; subject: string };

/** What the orchestrator hands the Analyst: the task, the plan (its focus and steps) and the round's context. */
export type AnalysisRequest = {
  task: Task;
  question: string;
  as_of: string;
  trade?: PlannerTrade | null;
  /** From the plan: what this review must establish. */
  focus: string;
  /** The planned steps, run in this order. */
  steps: readonly PlannedStep[];
  memories?: readonly RecalledMemory[];
  /** World Model facts; an empty list until src/agent/world.ts exists. */
  world?: readonly unknown[];
  /** On a retry: the last round's findings, so the Analyst revises rather than starts again. Null in round 1. */
  previous_findings?: readonly Finding[] | null;
  /** On a retry: the Evaluator's fix. Null in round 1. */
  feedback?: string | null;
  /** On a retry: the previous findings the fix flags. Code keeps every other one. */
  flagged_findings?: readonly FlaggedFinding[] | null;
  /**
   * thesis_check: one batch of theses with their evidence tables. Code has run every query, so the Analyst gets these
   * instead of results and offers the model no tools.
   */
  theses?: readonly ThesisEvidence[];
  /** pre_trade: code has run every query the review needs, so the model is offered no tools. */
  noTools?: boolean;
};

/** The user message, exactly as the model sees it. */
export type AnalystInput = {
  task: Task;
  question: string;
  as_of: string;
  trade: PlannerTrade | null;
  focus: string;
  memories: MemoryForModel[];
  world: unknown[];
  results: ResultForModel[];
  previous_findings: Finding[] | null;
  feedback: string | null;
  /** On a retry: the previous findings the feedback flags; null in round 1. */
  flagged_findings: FlaggedFinding[] | null;
  /** Only for thesis_check: the batch's theses, each with its evidence table. */
  theses?: ThesisEvidence[];
};

export type AnalyseDeps = {
  /** The run's cache, store, usage and budget; its tracer and config are used. */
  run: RunState;
  /** Default run.sampleMode. */
  sampleMode?: boolean;
  /** The time left in the run for each model call. */
  timeoutMs?: number;
  /** When the round ends; passed on to llm.ts for its empty_response retries. */
  roundDeadlineMs?: number;
  /** The run's cancel signal; it goes to every model call this agent makes. */
  signal?: AbortSignal;
  /** The loop round, 0 in the first; written as retry_count on the trace lines. */
  round?: number;
  /** For tests: a stand-in for llm.ts's complete. */
  complete?: (options: CompleteOptions) => Promise<CompleteResult>;
};

/** A planned step that did not run: the guard refused it or local() could not answer it. */
export type SkippedStep = { query_id: string; params: Record<string, unknown>; reason: string };

export type AnalysisError = { type: "BadJson" | "Blocked"; message: string; recoverable: true };

type AnalysisBase = {
  /** Every result the Analyst saw, trimmed as the model saw it: the planned ones first, then tool results, each once. */
  results: ResultForModel[];
  skipped: SkippedStep[];
  tool_rounds: number;
  tool_calls: number;
  model: {
    model_id: string;
    source: CompleteResult["source"];
    /** Summed over the calls of this analysis; null when no call reported usage. */
    usage: { tokens_in: number; tokens_out: number } | null;
    calls: number;
    duration_ms: number;
    fallback?: CompleteResult["fallback"];
  };
};

export type AnalysisOutcome =
  | (AnalysisBase & {
      ok: true;
      findings: Finding[];
      gaps: string[];
      /** The figure-free forms of the gaps code wrote (codeGaps); `gaps` holds their full texts and the model's own words. */
      code_gaps: string[];
      /** The previous findings the Analyst withdrew on purpose; empty in round 1. */
      retracted: Retraction[];
      injection_seen: boolean;
    })
  | (AnalysisBase & { ok: false; error: AnalysisError });

/** prompts/analyst.md as-is with its hash, read once (prompts.ts). */
export function analystPromptVersion(): PromptVersion {
  return promptVersion("analyst");
}

/** The text of prompts/analyst.md. */
export function analystPrompt(): string {
  return analystPromptVersion().text;
}

const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unreadable]";
  }
};

/** The task's named queries as OpenAI function definitions: name = the query id, description, parameters = its params as JSON schema. */
export function toolsFor(task: Task): ToolSpec[] {
  return catalogueFor(task).map((entry) => ({
    type: "function",
    function: { name: entry.id, description: entry.description, parameters: entry.params },
  }));
}

/** A catalogue id as code-trusted text may hold it; anything else (a Planner's unknown name) is not repeated. */
const trustedQueryId = (id: string): string => (isQueryId(id) ? id : "a planned query");

/**
 * The gaps code adds: a planned step that did not run and a result with no rows are gaps, never guesses. `gaps` are
 * the full texts, with the params and the reason, for the review (untrusted: their figures count only when a row holds
 * them). `trusted` are the forms code_gaps carry, whose figures the Writer may repeat: a catalogue id and fixed words
 * only, because the params come from the Planner or a tool call (sessions 73, symbol "ZZ 99.9") and a reason can
 * echo them.
 */
export function codeGapsOf(results: readonly ResultForModel[], skipped: readonly SkippedStep[]): { gaps: string[]; trusted: string[] } {
  const gaps: string[] = [];
  const trusted: string[] = [];
  for (const step of skipped) {
    gaps.push(`${step.query_id} ${safeJson(step.params)} did not run: ${step.reason}`);
    trusted.push(`${trustedQueryId(step.query_id)} did not run.`);
  }
  for (const result of results) {
    if (result.row_count !== 0) continue;
    gaps.push(`${result.query_id} ${safeJson(result.params)} returned no rows, so this review says nothing it would have shown.`);
    trusted.push(`${trustedQueryId(result.query_id)} returned no rows, so this review says nothing it would have shown.`);
  }
  return { gaps, trusted: [...new Set(trusted)] };
}

/** The code_gaps forms of codeGapsOf: what the Writer may repeat figures from. */
export function codeGaps(results: readonly ResultForModel[], skipped: readonly SkippedStep[]): string[] {
  return codeGapsOf(results, skipped).trusted;
}

type Call = NonNullable<AnalyseDeps["complete"]>;

/**
 * Analyses one task: runs the planned queries in plan order (the cache, then runQuery, so guards.beforeQuery), then
 * calls the main model with the task's queries as tools, runs each tool call the same way, at most MAX_TOOL_ROUNDS
 * rounds, then once more without tools. Every model call counts against MAX_MODEL_CALLS and the token budget
 * (BudgetExhaustedError from the run state when none is left; model errors from llm.ts pass through). A reply that
 * fails the schema or guards.afterModel is `{ ok: false, error }` with what was gathered; the run goes on.
 */
export async function analyse(request: AnalysisRequest, deps: AnalyseDeps): Promise<AnalysisOutcome> {
  const { run } = deps;
  const cfg = run.config;
  const tracer = run.tracer;
  const round = deps.round ?? 0;
  const sampleMode = deps.sampleMode ?? run.sampleMode;
  const call: Call = deps.complete ?? completeModel;
  const started = Date.now();

  // 1. The planned queries, in plan order. A step the guard refuses, or local() cannot answer, is skipped and
  // traced; it becomes a gap, never a crash.
  const seen = new Map<string, QueryResult>();
  const skipped: SkippedStep[] = [];
  for (const [index, step] of request.steps.entries()) {
    try {
      const result = await run.query(step.query_id, step.params, { caller: "Orchestrator", task: request.task });
      if (!seen.has(result.run_query_id)) seen.set(result.run_query_id, result);
    } catch (error) {
      if (!(error instanceof QueryBlockedError) && !(error instanceof QueryError)) throw error;
      const reason = error instanceof QueryBlockedError ? error.reason : error.message;
      skipped.push({ query_id: step.query_id, params: step.params, reason });
      tracer.log({
        agent_name: AGENT,
        action: "step_skipped",
        input_summary: capped(`step ${index + 1} of ${request.steps.length}: ${step.query_id} ${safeJson(step.params)}`),
        output_summary: capped(`not run: ${reason}`),
        status: error instanceof QueryBlockedError ? "blocked" : "error",
        why: reason,
        retry_count: round,
      });
    }
  }

  const trimmed = (result: QueryResult) => forModel(result, cfg.MAX_ROWS_PER_QUERY);
  const results: ResultForModel[] = [...seen.values()].map(trimmed);
  const input: AnalystInput = {
    task: request.task,
    question: request.question,
    as_of: request.as_of,
    trade: request.trade ?? null,
    focus: request.focus,
    memories: memoriesForModel(request.memories ?? [], cfg.MAX_MEMORIES),
    world: [...(request.world ?? [])],
    results,
    previous_findings: request.previous_findings === undefined || request.previous_findings === null ? null : [...request.previous_findings],
    feedback: request.feedback ?? null,
    flagged_findings: request.flagged_findings === undefined || request.flagged_findings === null ? null : [...request.flagged_findings],
    ...(request.theses === undefined ? {} : { theses: [...request.theses] }),
  };
  // thesis_check and pre_trade: code has run every query, so the model is offered no tools.
  const tools = request.theses === undefined && request.noTools !== true ? toolsFor(request.task) : [];

  // On a retry, the results the previous findings cite stay in view even when this round's plan left their query
  // out, so the Analyst can keep or fix those findings. They come from the run's store (no query runs, none is
  // counted). thesis_check gets none: its evidence tables already carry every run_query_id to cite. The input as it
  // stands (the feedback included) is counted first, then each result is added only while the prompt leaves room for
  // every tool round (toolReserveChars, when tools are offered) and for a structured retry's correction
  // (RETRY_NOTE_CHARS); one that does not fit is left out and counted in the trace
  // (code still checks a kept finding against the full store).
  let previousCited = 0;
  let previousLeftOut = 0;
  const systemChars = analystPromptVersion().text.length;
  const reserve = (tools.length > 0 ? toolReserveChars(cfg, run.store) : 0) + RETRY_NOTE_CHARS;
  const cited = request.theses === undefined ? (request.previous_findings ?? []).flatMap((finding) => finding.cites) : [];
  for (const id of new Set(cited)) {
    const held = run.store[id];
    if (held === undefined || seen.has(id)) continue;
    const extra = trimmed(held);
    if (systemChars + JSON.stringify(input).length + JSON.stringify(extra).length + 1 + reserve > cfg.MAX_PROMPT_CHARS) {
      previousLeftOut += 1;
      continue;
    }
    seen.set(id, held);
    results.push(extra);
    previousCited += 1;
  }
  // What the Analyst saw, returned to the caller: the user message's results, then each tool result once. Tool
  // results live in the history only; they are never copied into `results`, which is serialised as the user message.
  const returned: ResultForModel[] = [...results];
  const inputSummary = capped(
    `task=${input.task} as_of=${input.as_of} question ${input.question.length} chars, ${results.length} results (${results.reduce((n, r) => n + r.row_count, 0)} rows${previousCited > 0 ? `, ${previousCited} kept for the previous findings` : ""}${previousLeftOut > 0 ? `, ${previousLeftOut} left out for size` : ""}), ${request.theses === undefined ? "" : `${request.theses.length} theses, `}${skipped.length} skipped, ${input.memories.length} memories, ${input.world.length} world facts, previous_findings=${input.previous_findings === null ? "none" : `${input.previous_findings.length}${input.flagged_findings === null || input.flagged_findings.length === 0 ? "" : ` (${input.flagged_findings.length} flagged)`}`}, feedback=${input.feedback === null ? "none" : `${input.feedback.length} chars`}`,
  );

  // 2. The model, with the task's queries as tools (above); each tool call runs through the same cache and guard.
  const history: HistoryMessage[] = [];
  const model: AnalysisBase["model"] = { model_id: "", source: "sample-model", usage: null, calls: 0, duration_ms: 0 };
  let toolRounds = 0;
  let toolCalls = 0;
  let result: CompleteResult;
  for (;;) {
    const withTools = tools.length > 0 && toolRounds < cfg.MAX_TOOL_ROUNDS;
    run.beforeModelCall();
    try {
      result = await call({
        system: analystPromptVersion().text,
        prompt_hash: analystPromptVersion().prompt_hash,
        user: JSON.stringify(input),
        model: "main",
        json: true,
        validate: analystReplyProblem,
        replyShape: ANALYST_REPLY_SHAPE,
        ...(withTools ? { tools } : {}),
        ...(history.length === 0 ? {} : { history: [...history] }),
        agent: AGENT,
        tracer,
        config: cfg,
        sampleMode,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.roundDeadlineMs === undefined ? {} : { roundDeadlineMs: deps.roundDeadlineMs }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        modelCallsLeft: run.modelCallsLeft(),
        tokensLeft: run.tokensLeft(),
      });
    } catch (error) {
      // A failed call still counts: every request it made is a model call.
      run.afterFailedModelCall(failedCallUsage(error));
      throw error;
    }
    run.afterModelCall(result);
    model.calls += 1;
    model.model_id = result.model_id;
    model.source = result.source;
    model.duration_ms += result.duration_ms;
    if (result.fallback !== undefined) model.fallback = result.fallback;
    if (result.usage !== null) {
      model.usage = { tokens_in: (model.usage?.tokens_in ?? 0) + result.usage.tokens_in, tokens_out: (model.usage?.tokens_out ?? 0) + result.usage.tokens_out };
    }

    const calls = result.tool_calls ?? [];
    if (!withTools || calls.length === 0) break;

    toolRounds += 1;
    history.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: safeJson(c.arguments) } })),
    });
    for (const [index, c] of calls.entries()) {
      if (index >= cfg.MAX_TOOL_CALLS_PER_ROUND) {
        // Past the per-round cap: nothing runs, and the model is told why in the call's own tool message.
        const reason = `MAX_TOOL_CALLS_PER_ROUND (${cfg.MAX_TOOL_CALLS_PER_ROUND}) calls already ran in this tool round, so this one did not run.`;
        tracer.log({ agent_name: AGENT, action: "tool_call", input_summary: capped(`${c.name} ${safeJson(c.arguments)}`), output_summary: capped(`not run: ${reason}`), target_agent: QUERY_AGENT, status: "rejected", why: reason, model: result.model_id, retry_count: round });
        history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: reason, query_id: c.name }) });
        continue;
      }
      toolCalls += 1;
      const outcome = await runToolCall(c, { run, task: request.task, round, model: result.model_id });
      if (outcome.result !== undefined && !seen.has(outcome.result.run_query_id)) {
        seen.set(outcome.result.run_query_id, outcome.result);
        returned.push(trimmed(outcome.result));
      }
      history.push({ role: "tool", tool_call_id: c.id, content: outcome.content });
    }
    if (toolRounds >= cfg.MAX_TOOL_ROUNDS) {
      tracer.log({
        agent_name: AGENT,
        action: "tool_rounds_exhausted",
        input_summary: `${toolRounds} tool rounds, ${toolCalls} tool calls`,
        output_summary: `MAX_TOOL_ROUNDS (${cfg.MAX_TOOL_ROUNDS}) reached; the next call offers no tools, so the model must answer`,
        status: "ok",
        why: `MAX_TOOL_ROUNDS (${cfg.MAX_TOOL_ROUNDS}) reached`,
        model: result.model_id,
        retry_count: round,
      });
    }
  }

  const base: AnalysisBase = { results: returned, skipped, tool_rounds: toolRounds, tool_calls: toolCalls, model };
  const fail = (error: AnalysisError, status: TraceStatus): AnalysisOutcome => {
    tracer.log({
      agent_name: AGENT,
      action: "analyse",
      input_summary: inputSummary,
      output_summary: capped(`${status}: ${error.message}`),
      target_agent: TARGET,
      status,
      why: error.message,
      model: model.model_id,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    return { ...base, ok: false, error };
  };

  // 3. The reply: zod, then the guard. A failure of either is a structured error with what was gathered.
  const raw = result.json;
  if (raw === null || raw === undefined) {
    const message = result.tool_calls === undefined ? "The reply is not a JSON object." : "The model answered with tool calls when no tools were offered; the findings are missing.";
    return fail({ type: "BadJson", message, recoverable: true }, "rejected");
  }
  const parsed = analystReplySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail({ type: "BadJson", message: `The reply does not match the Analyst schema (${issue.path.join(".") || "reply"}: ${issue.message}).`, recoverable: true }, "rejected");
  }
  const findings = parsed.data.findings;
  const gaps = [...parsed.data.gaps];
  const retracted = parsed.data.retracted;
  const written = codeGapsOf(returned, skipped);
  const code_gaps = written.trusted;
  for (const gap of written.gaps) if (!gaps.includes(gap)) gaps.push(gap);

  const guard = afterModel(AGENT, { findings, gaps, retracted }, input, tracer);
  if (!guard.ok) return fail({ type: "Blocked", message: guard.reason, recoverable: true }, "blocked");

  tracer.log({
    agent_name: AGENT,
    action: "analyse",
    input_summary: inputSummary,
    output_summary: capped(
      `${findings.length} findings (${findings.map((f) => `${f.kind}:${f.subject}`).join(", ") || "none"}); ${gaps.length} gaps; ${retracted.length > 0 ? `${retracted.length} retracted (${retracted.map((r) => `${r.kind}:${r.subject}`).join(", ")}); ` : ""}${toolCalls} tool calls in ${toolRounds} rounds; injection_seen=${guard.injection_seen}`,
    ),
    target_agent: TARGET,
    status: "ok",
    model: model.model_id,
    retry_count: round,
    duration_ms: Date.now() - started,
  });
  return { ...base, ok: true, findings, gaps, code_gaps, retracted, injection_seen: guard.injection_seen };
}

type ToolOutcome = { content: string; result?: QueryResult };

/**
 * One tool call, run by code: a query of this task through the run's cache and runQuery (guards.beforeQuery), its
 * trimmed result sent back as the tool message. A blocked (policy included), refused or malformed call goes back as a tool message
 * with the reason; nothing is thrown for it. Traced as agent "Analyst", action "tool_call".
 */
async function runToolCall(c: ToolCallResult, ctx: { run: RunState; task: string; round: number; model: string }): Promise<ToolOutcome> {
  const { run, round } = ctx;
  const summary = capped(`${c.name} ${safeJson(c.arguments)}`);
  const log = (status: TraceStatus, output: string, why?: string) =>
    run.tracer.log({
      agent_name: AGENT,
      action: "tool_call",
      input_summary: summary,
      output_summary: capped(output),
      target_agent: QUERY_AGENT,
      status,
      ...(why === undefined ? {} : { why }),
      model: ctx.model,
      retry_count: round,
    });
  const refused = (reason: string, status: TraceStatus): ToolOutcome => {
    log(status, `not run: ${reason}`, reason);
    return { content: JSON.stringify({ error: reason, query_id: c.name }) };
  };

  if (c.error === "bad_arguments") return refused("The tool call's arguments are not a JSON object, so it did not run.", "rejected");
  // A query outside this task's tools never runs: src/agent/policy.ts refuses it inside guards.beforeQuery, with the
  // reason sent back to the model, and an unknown name is refused there too. Neither counts a query call.
  const before = run.usage.query_calls;
  try {
    const result = await run.query(c.name, c.arguments, { caller: AGENT, task: ctx.task });
    const cached = run.usage.query_calls === before;
    log("ok", `${result.rows.length} rows, run_query_id ${result.run_query_id}${cached ? " (from the cache)" : ""}`);
    return { content: JSON.stringify(forModel(result, run.config.MAX_ROWS_PER_QUERY)), result };
  } catch (error) {
    if (error instanceof QueryBlockedError) return refused(error.reason, "blocked");
    if (error instanceof QueryError) return refused(error.message, "error");
    throw error;
  }
}
