// The Evaluator: judges the Analyst's draft. Code runs first, in this order: guards.checkCitations (every number is
// in a cited row), guards.afterModel (no advice, every finding matches the schema), then coverage (the task's
// required findings are there). Each failure is a rejection with a one-sentence fix written by code that the
// Planner and the Analyst can act on; no model is called. A draft that passes goes to the fast model with
// prompts/evaluator.md as-is and one JSON user message (rule 7): the draft and only the rows it cites. The three
// scores add up to a total out of 9; total / 9 rounded to two decimals is the trace's confidence (7 of 9 is 0.78);
// 7 or more is accepted and goes to the Writer. When the fast model returns no answer even after llm.ts's retries
// (a ModelHttpError 502), or none of its replies can be read as a score after llm.ts's tries (BadJson), the draft is
// accepted on the code checks alone, with no score: action "score_unavailable".
// Server only (node:fs reads the prompt).
import { z } from "zod";
import { loadConfig, type Config } from "../config";
import { citedResults, citedResultsForSubjects, memoriesForModel, type MemoryForModel, type ResultForModel, type ResultStore, type Task } from "../context";
import { afterModel, checkCitations, type Finding } from "../guards";
import { BadJson, complete as completeModel, failedCallUsage, ModelHttpError, schemaReason, type CompleteOptions, type CompleteResult } from "../llm";
import { promptVersion, type PromptVersion } from "../prompts";
import type { RecalledMemory } from "../memory";
import type { QueryId, QueryResult, Row } from "../queries";
import type { RunState } from "../run-state";
import type { Tracer } from "../trace";

const AGENT = "Evaluator";
const SUMMARY_CHARS = 200;
const PORTFOLIO = "PORTFOLIO";

/** A total of 7 or more out of MAX_TOTAL goes to the Writer. */
export const PASS_TOTAL = 7;
export const MAX_TOTAL = 9;

/** The tasks whose plan comes from the Planner: a rejection goes back there. The others go back to the Analyst. */
const PLANNED_TASKS: readonly Task[] = ["explain_week", "thesis_check"];
export type RejectTarget = "Planner" | "Analyst";
export const rejectTarget = (task: Task): RejectTarget => (PLANNED_TASKS.includes(task) ? "Planner" : "Analyst");

// The reply the prompt defines: three whole scores from 0 to 3 and a fix, empty when the total is 7 or more.
const score = z.number().int().min(0).max(3);
export const scoreSchema = z.object({ accuracy: score, appropriateness: score, actionability: score, fix: z.string().catch("") });
export type Scores = { accuracy: number; appropriateness: number; actionability: number };

/** The reply's shape as prompts/evaluator.md gives it, restated by llm.ts when it asks again after a bad reply. */
export const EVALUATOR_REPLY_SHAPE = '{"accuracy": 0, "appropriateness": 0, "actionability": 0, "fix": ""}, each score a whole number from 0 to 3';

/** Why a parsed reply fails the Evaluator schema (the first issue), or null; llm.ts asks again with it. */
export function scoreReplyProblem(json: Record<string, unknown>): string | null {
  const parsed = scoreSchema.safeParse(json);
  if (parsed.success) return null;
  return schemaReason(parsed.error.issues[0]);
}

/** What the orchestrator hands the Evaluator: the draft and the run's result store. */
export type EvaluateInput = {
  task: Task;
  question: string;
  as_of: string;
  findings: readonly Finding[];
  gaps?: readonly string[];
  memories?: readonly RecalledMemory[];
  /** Every result of this run in full (RunState.store): checkCitations and the coverage check read it. */
  results: ResultStore;
};

/** The user message, exactly as the model sees it: the draft and only the rows its findings cite. */
export type EvaluatorInput = {
  task: Task;
  question: string;
  as_of: string;
  memories: MemoryForModel[];
  findings: Finding[];
  gaps: string[];
  results: ResultForModel[];
};

export type EvaluateDeps = {
  tracer: Tracer;
  /** The run's budget: when given, each model call goes through beforeModelCall and afterModelCall, and its config and sample mode are the defaults. */
  run?: Pick<RunState, "beforeModelCall" | "afterModelCall" | "afterFailedModelCall" | "modelCallsLeft" | "config" | "sampleMode"> & Partial<Pick<RunState, "tokensLeft">>;
  config?: Config;
  sampleMode?: boolean;
  /** The time left in the run for the model call. */
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

export type CheckName = "citations" | "guard" | "coverage";
/** One code check: what it found and, when it failed, the fix code wrote. */
export type CodeCheck = { check: CheckName; ok: boolean; reason: string; fix: string | null };

export type EvaluateError = { type: "BadJson" | "Blocked"; message: string; recoverable: true };

export type EvaluateOutcome = {
  accepted: boolean;
  /** Null when code rejected the draft, the model's reply was unusable or the model returned no answer. */
  scores: Scores | null;
  /** Null when the model returned no answer and the draft was accepted on the code checks alone (score_unavailable). */
  total: number | null;
  /** total / 9 rounded to two decimals; 0 when code rejected the draft or the reply was unusable; null when the score is unavailable. */
  confidence: number | null;
  /** One instruction for the Planner and the Analyst; empty when accepted. */
  fix: string;
  code_checks: CodeCheck[];
  target_agent: RejectTarget | "Writer";
  model: {
    model_id: string;
    source: CompleteResult["source"];
    usage: CompleteResult["usage"];
    duration_ms: number;
    fallback?: CompleteResult["fallback"];
  } | null;
  /** Set when the model's reply failed the schema or the guard; the draft got no score. */
  error?: EvaluateError;
};

/** prompts/evaluator.md as-is with its hash, read once (prompts.ts). */
export function evaluatorPromptVersion(): PromptVersion {
  return promptVersion("evaluator");
}

/** The text of prompts/evaluator.md. */
export function evaluatorPrompt(): string {
  return evaluatorPromptVersion().text;
}

const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** total / 9 as a fraction rounded to two decimals: 7 of 9 is 0.78. */
export const confidenceOf = (total: number): number => Math.round((total / MAX_TOTAL) * 100) / 100;

function depsOf(arg: Tracer | EvaluateDeps): EvaluateDeps {
  return "log" in arg && typeof arg.log === "function" ? { tracer: arg } : (arg as EvaluateDeps);
}

// ---------------------------------------------------------------------------------------------------------------
// Coverage: the task's required findings, from the run's own rows.

export type CoverageResult = { ok: true; reason: string } | { ok: false; reason: string; fix: string };

function resultsOf(store: ResultStore, queryId: QueryId, asOf?: string): QueryResult[] {
  const all = Object.values(store).filter((result) => result.query_id === queryId);
  const same = asOf === undefined ? [] : all.filter((result) => result.params.as_of === asOf);
  return same.length > 0 ? same : all;
}

function largestHolding(rows: readonly Row[]): Row | undefined {
  let best: Row | undefined;
  let size = -1;
  for (const row of rows) {
    if (row.symbol === PORTFOLIO) continue;
    const magnitude = Math.abs(num(row.contribution_bdt) ?? 0);
    if (magnitude > size) {
      best = row;
      size = magnitude;
    }
  }
  return best;
}

/**
 * explain_week: the holding with the largest absolute contribution in this run's week_moves rows (the PORTFOLIO
 * row aside) is the subject of at least one finding. thesis_check: every journal id in the run's journal rows has
 * a thesis finding with a verdict. pre_trade: a pre_trade finding. reconcile: every issue_id in the run's
 * reconciliation rows has a reconciliation finding. A task whose evidence query never ran fails with a fix that
 * plans it.
 */
export function coverage(task: Task, findings: readonly Finding[], store: ResultStore, asOf: string): CoverageResult {
  switch (task) {
    case "explain_week": {
      const moves = resultsOf(store, "week_moves", asOf);
      if (moves.length === 0) {
        return { ok: false, reason: "no week_moves result is in this run", fix: `Plan week_moves for ${asOf}: no result in this run shows the week's moves.` };
      }
      const largest = largestHolding(moves.flatMap((result) => result.rows));
      if (largest === undefined) return { ok: true, reason: "week_moves has no holding rows, so there is no largest move to cover" };
      const symbol = str(largest.symbol);
      if (!findings.some((finding) => finding.subject === symbol)) {
        return { ok: false, reason: `${symbol} is the largest move of the week and has no finding`, fix: `Explain ${symbol}: it is the largest move of the week and has no finding.` };
      }
      return { ok: true, reason: `${symbol}, the largest move of the week, has a finding` };
    }
    case "thesis_check": {
      const journals = resultsOf(store, "journal_for_symbol", asOf);
      if (journals.length === 0) {
        return { ok: false, reason: "no journal_for_symbol result is in this run", fix: `Plan journal_for_symbol for ${asOf}: no result in this run lists the theses.` };
      }
      const ids = [...new Set(journals.flatMap((result) => result.rows.map((row) => str(row.id))).filter((id) => id !== ""))];
      // Every thesis has exactly one finding with a verdict; the fix names each journal id that failed.
      const forId = (id: string) => findings.filter((finding) => finding.kind === "thesis" && finding.subject === id);
      const problems = ids.flatMap((id) => {
        const own = forId(id);
        if (own.length === 0) return [`${id}: no thesis finding`];
        if (own.length > 1) return [`${id}: ${own.length} findings, one is needed`];
        return own[0].verdict === null ? [`${id}: no verdict`] : [];
      });
      if (problems.length > 0) {
        return {
          ok: false,
          reason: `${problems.length} ${problems.length === 1 ? "thesis fails" : "theses fail"} the coverage check (${problems.join("; ")})`,
          fix: `Give each of these theses exactly one finding with a verdict of confirmed, contradicted or open: ${problems.join("; ")}.`,
        };
      }
      return { ok: true, reason: ids.length === 0 ? "the journal has no thesis to cover" : `every thesis (${ids.join(", ")}) has a verdict` };
    }
    case "pre_trade": {
      if (!findings.some((finding) => finding.kind === "pre_trade")) {
        return { ok: false, reason: "the draft has no pre_trade finding", fix: "Report what what_if says the trade would change: the draft has no pre_trade finding." };
      }
      return { ok: true, reason: "the draft has a pre_trade finding" };
    }
    case "reconcile": {
      const results = resultsOf(store, "reconciliation");
      if (results.length === 0) {
        return { ok: false, reason: "no reconciliation result is in this run", fix: "Plan reconciliation: no result in this run lists the differences." };
      }
      const ids = [...new Set(results.flatMap((result) => result.rows.map((row) => str(row.issue_id))).filter((id) => id !== ""))];
      const missing = ids.filter((id) => !findings.some((finding) => finding.kind === "reconciliation" && finding.subject === id));
      if (missing.length > 0) {
        const more = missing.length > 1 ? ` (and ${missing.length - 1} more)` : "";
        return { ok: false, reason: `issue ${missing[0]} has no finding${more}`, fix: `Add a finding and a proposed fix for issue ${missing[0]}: it has no finding${more}.` };
      }
      return { ok: true, reason: ids.length === 0 ? "the reconciliation has no difference to cover" : `every difference (${ids.join(", ")}) has a finding` };
    }
    default:
      return { ok: true, reason: `no coverage rule for task ${String(task)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The fixes code writes for the first two checks.

function citationFix(findings: readonly Finding[], failures: readonly { finding: number; problem: string }[]): string {
  const first = failures[0];
  const finding = findings[first.finding - 1];
  const who = finding === undefined ? `finding ${first.finding}` : `finding ${first.finding} (${finding.kind} ${finding.subject})`;
  const more = failures.length > 1 ? ` (and ${failures.length - 1} more ${failures.length === 2 ? "problem" : "problems"})` : "";
  return `Fix ${who}: ${first.problem}; use only figures from the rows it cites${more}.`;
}

function guardFix(reason: string): string {
  if (/tells the owner what to trade/.test(reason)) return "Remove every sentence that tells the owner to buy, sell or hold; say only what the rows show.";
  if (/a thesis verdict is confirmed, contradicted or open/.test(reason)) return "Give every thesis finding a verdict of confirmed, contradicted or open.";
  if (/does not match the finding schema/.test(reason)) {
    const detail = reason.match(/finding (\d+) does not match the finding schema \(([^)]*)\)/);
    return detail === null
      ? "Give every finding a kind, a non-empty subject, a claim, numbers, cites, verdict, proposed_fix and memory_ids."
      : `Give finding ${detail[1]} a kind, a non-empty subject, a claim, numbers, cites, verdict, proposed_fix and memory_ids (${detail[2]}).`;
  }
  return `Fix the draft so the reply guard allows it: ${reason.replace(/\.$/, "")}.`;
}

/** When the model scores below 7 and names no fix, the lowest score says what to revise. */
function fallbackFix(task: Task, scores: Scores): string {
  const lowest = (["accuracy", "appropriateness", "actionability"] as const).reduce((a, b) => (scores[b] < scores[a] ? b : a));
  if (lowest === "accuracy") return "Rewrite each claim to say only what its cited rows show, with every figure listed in numbers.";
  if (lowest === "actionability") return "Name the holding, sector, thesis or rule the owner should look at next.";
  switch (task) {
    case "thesis_check":
      return "Give every thesis a verdict of confirmed, contradicted or open, quoting the row that settles it.";
    case "pre_trade":
      return "Report every new finding from what_if and whether the trade fits the owner's thesis.";
    case "reconcile":
      return "Give every difference an explanation and a proposed fix for the owner to approve.";
    default:
      return "Lead with the portfolio's move against DSEX and the largest holding move from week_moves.";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// evaluate

type Call = NonNullable<EvaluateDeps["complete"]>;

/**
 * Evaluates one draft: the three code checks in order, each traced as action "code_check" with its reason, then
 * one verdict line, action "reject" (the fix in why, target_agent Planner for a planned task, else Analyst) or
 * "accept" (target_agent Writer), with confidence. A draft that passes the code checks is scored by the fast model;
 * the three scores go to output_summary and total / 9 to confidence. A ModelHttpError 502 from the scoring call
 * (no answer after llm.ts's retries), or a BadJson (no reply readable as a score after its tries), accepts the draft
 * on the code checks alone: one "score_unavailable" line,
 * scores, total and confidence null. Other model errors from llm.ts and BudgetExhaustedError from the run state pass
 * through; a reply that fails the schema or the guard is an `error` on the outcome, never a crash.
 */
export async function evaluate(input: EvaluateInput, arg: Tracer | EvaluateDeps): Promise<EvaluateOutcome> {
  const deps = depsOf(arg);
  const { tracer, run } = deps;
  const cfg = deps.config ?? run?.config ?? loadConfig(process.env, () => {});
  const sampleMode = deps.sampleMode ?? run?.sampleMode ?? cfg.sampleMode;
  const call: Call = deps.complete ?? completeModel;
  const round = deps.round ?? 0;
  const started = Date.now();
  const findings = [...input.findings];
  const gaps = [...(input.gaps ?? [])];
  const memories = input.memories ?? [];
  const target = rejectTarget(input.task);
  const inputSummary = capped(
    `task=${input.task} as_of=${input.as_of} ${findings.length} findings (${findings.map((f) => `${f.kind}:${f.subject}`).join(", ") || "none"}), ${gaps.length} gaps, ${memories.length} memories, ${Object.keys(input.results).length} results in the run`,
  );
  const checks: CodeCheck[] = [];

  const traceCheck = (check: CodeCheck) => {
    checks.push(check);
    tracer.log({
      agent_name: AGENT,
      action: "code_check",
      input_summary: capped(`${check.check}: ${findings.length} findings`),
      output_summary: capped(check.ok ? `passed: ${check.reason}` : `failed: ${check.reason}`),
      status: check.ok ? "ok" : "rejected",
      why: check.reason,
      retry_count: round,
    });
  };
  const rejectByCode = (check: CodeCheck): EvaluateOutcome => {
    const fix = check.fix ?? "";
    tracer.log({
      agent_name: AGENT,
      action: "reject",
      input_summary: inputSummary,
      output_summary: capped(`rejected by code (${check.check}): ${check.reason}; no model call`),
      target_agent: target,
      status: "rejected",
      why: fix,
      confidence: 0,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    return { accepted: false, scores: null, total: 0, confidence: 0, fix, code_checks: checks, target_agent: target, model: null };
  };

  // 1. Every number is in a cited row of this run (or in a listed memory).
  const citations = checkCitations(findings, input.results, memories, tracer);
  const citationCheck: CodeCheck = citations.ok
    ? { check: "citations", ok: true, reason: "every finding cites a result of this run and every number is in the cited rows", fix: null }
    : { check: "citations", ok: false, reason: citations.reason, fix: citationFix(findings, citations.failures) };
  traceCheck(citationCheck);
  if (!citationCheck.ok) return rejectByCode(citationCheck);

  // 2. No advice, every finding matches the schema, a verdict where the task needs one. The draft is the Analyst's reply.
  const guard = afterModel("Analyst", { findings, gaps }, { task: input.task }, tracer);
  const guardCheck: CodeCheck = guard.ok
    ? { check: "guard", ok: true, reason: `the draft passes the reply guard${guard.injection_seen ? " (injection wording seen)" : ""}`, fix: null }
    : { check: "guard", ok: false, reason: guard.reason, fix: guardFix(guard.reason) };
  traceCheck(guardCheck);
  if (!guardCheck.ok) return rejectByCode(guardCheck);

  // 3. The task's required findings are there.
  const covered = coverage(input.task, findings, input.results, input.as_of);
  const coverageCheck: CodeCheck = covered.ok ? { check: "coverage", ok: true, reason: covered.reason, fix: null } : { check: "coverage", ok: false, reason: covered.reason, fix: covered.fix };
  traceCheck(coverageCheck);
  if (!coverageCheck.ok) return rejectByCode(coverageCheck);

  // 4. The fast model scores the draft, seeing only the rows the findings cite.
  const user: EvaluatorInput = {
    task: input.task,
    question: input.question,
    as_of: input.as_of,
    memories: memoriesForModel(memories, cfg.MAX_MEMORIES),
    findings,
    gaps,
    results: input.task === "thesis_check" ? citedResultsForSubjects(findings, input.results, cfg.MAX_ROWS_PER_QUERY) : citedResults(findings, input.results, cfg.MAX_ROWS_PER_QUERY),
  };
  run?.beforeModelCall();
  let result: CompleteResult;
  try {
    result = await call({
      system: evaluatorPromptVersion().text,
      prompt_hash: evaluatorPromptVersion().prompt_hash,
      user: JSON.stringify(user),
      model: "fast",
      json: true,
      validate: scoreReplyProblem,
      replyShape: EVALUATOR_REPLY_SHAPE,
      agent: AGENT,
      tracer,
      config: cfg,
      sampleMode,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.roundDeadlineMs === undefined ? {} : { roundDeadlineMs: deps.roundDeadlineMs }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(run === undefined ? {} : { modelCallsLeft: run.modelCallsLeft(), ...(run.tokensLeft === undefined ? {} : { tokensLeft: run.tokensLeft() }) }),
    });
  } catch (error) {
    // A failed scoring call still counts: every request it made is a model call.
    run?.afterFailedModelCall(failedCallUsage(error));
    // The model returned no answer even after llm.ts's retries (a 502), or its replies still could not be read as a
    // score after llm.ts's tries (BadJson); its model_call line says why. The three code checks passed, so the draft
    // goes to the Writer unscored. Any other error passes through as before.
    const noAnswer = error instanceof ModelHttpError && error.status === 502;
    if (!noAnswer && !(error instanceof BadJson)) throw error;
    tracer.log({
      agent_name: AGENT,
      action: "score_unavailable",
      input_summary: inputSummary,
      output_summary: capped(`no score: ${error.message}; accepted on the code checks alone (citations, guard, coverage)`),
      target_agent: "Writer",
      status: "accepted",
      why: noAnswer ? "the model returned no answer; the code checks passed" : "the model's replies could not be read as a score; the code checks passed",
      confidence: null,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    return { accepted: true, scores: null, total: null, confidence: null, fix: "", code_checks: checks, target_agent: "Writer", model: null };
  }
  run?.afterModelCall(result);
  const model: NonNullable<EvaluateOutcome["model"]> = {
    model_id: result.model_id,
    source: result.source,
    usage: result.usage,
    duration_ms: result.duration_ms,
    ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
  };

  const badReply = (error: EvaluateError): EvaluateOutcome => {
    tracer.log({
      agent_name: AGENT,
      action: "bad_reply",
      input_summary: inputSummary,
      output_summary: capped(`${error.type}: ${error.message}`),
      status: "error",
      why: error.message,
      model: result.model_id,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    return { accepted: false, scores: null, total: 0, confidence: 0, fix: "", code_checks: checks, target_agent: target, model, error };
  };

  const parsed = scoreSchema.safeParse(result.json ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badReply({ type: "BadJson", message: `The reply does not match the Evaluator schema (${issue.path.join(".") || "reply"}: ${issue.message}).`, recoverable: true });
  }
  const replyGuard = afterModel(AGENT, parsed.data, { task: input.task }, tracer);
  if (!replyGuard.ok) return badReply({ type: "Blocked", message: replyGuard.reason, recoverable: true });

  const scores: Scores = { accuracy: parsed.data.accuracy, appropriateness: parsed.data.appropriateness, actionability: parsed.data.actionability };
  const total = scores.accuracy + scores.appropriateness + scores.actionability;
  const confidence = confidenceOf(total);
  const accepted = total >= PASS_TOTAL;
  const fix = accepted ? "" : parsed.data.fix.trim() || fallbackFix(input.task, scores);

  tracer.log({
    agent_name: AGENT,
    action: accepted ? "accept" : "reject",
    input_summary: inputSummary,
    output_summary: capped(`accuracy=${scores.accuracy} appropriateness=${scores.appropriateness} actionability=${scores.actionability} total=${total} of ${MAX_TOTAL}${accepted ? "" : `; fix: ${fix}`}`),
    target_agent: accepted ? "Writer" : target,
    status: accepted ? "accepted" : "rejected",
    ...(accepted ? {} : { why: fix }),
    confidence,
    model: result.model_id,
    retry_count: round,
    duration_ms: Date.now() - started,
  });
  return { accepted, scores, total, confidence, fix, code_checks: checks, target_agent: accepted ? "Writer" : target, model };
}
