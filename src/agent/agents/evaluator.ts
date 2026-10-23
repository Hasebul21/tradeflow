// The Evaluator: judges the Analyst's draft. Code runs first, in this order: guards.checkCitations (every number is
// in a cited row), guards.afterModel (no advice, every finding matches the schema), then coverage (the task's
// required findings are there). All three always run; any failure is a rejection with a fix written by code that
// names every problem found, and the numbers of the findings it flags, so the Planner and the Analyst can act on all
// of them in one round; no model is called. A draft that passes goes to the fast model with
// prompts/evaluator.md as-is and one JSON user message (rule 7): the draft and only the rows it cites. The three
// scores add up to a total out of 9; total / 9 rounded to two decimals is the trace's confidence (7 of 9 is 0.78);
// 7 or more is accepted and goes to the Writer. When the fast model returns no answer even after llm.ts's retries
// (a ModelHttpError 502), or none of its replies can be read as a score after llm.ts's tries (BadJson), the draft is
// accepted on the code checks alone, with no score: action "score_unavailable".
// A draft of more than EVALUATOR_BATCH_SIZE findings is scored in consecutive batches, each with only its own findings
// and cited rows: the lowest score per dimension counts, and a fix names findings by their number in the whole draft.
// Server only (node:fs reads the prompt).
import { z } from "zod";
import { loadConfig, type Config } from "../config";
import { citedResults, citedResultsForSubjects, memoriesForModel, type MemoryForModel, type ResultForModel, type ResultStore, type Task } from "../context";
import { afterModel, checkCitations, numbersIn, type Finding } from "../guards";
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

/** A draft with more findings than this is scored in batches of this size, so no prompt nears MAX_PROMPT_CHARS. */
export const EVALUATOR_BATCH_SIZE = 10;
/** A draft whose one-call prompt is at most this many characters is scored in one call; a longer one is scored in batches. 30,000 is three quarters of the 40,000-character prompt limit. */
export const EVALUATOR_SINGLE_CALL_MAX_CHARS = 30000;

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
  /** For tests: score in batches when the one-call prompt is longer than this many characters (default EVALUATOR_SINGLE_CALL_MAX_CHARS). */
  batchAboveChars?: number;
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
  /** The fix for the Planner and the Analyst, naming every problem found; empty when accepted. */
  fix: string;
  /**
   * The findings the rejection names, by number counting from 1: those a code check failed, or whose subject or
   * number the model's fix names. Empty when accepted. orchestrator.ts carries every other finding into the next draft.
   */
  flagged: number[];
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
        // Every missing issue is named, so the Analyst sees all of them in one round.
        const rest = missing.slice(1);
        const nor = rest.length === 0 ? "" : ` (nor ${rest.length === 1 ? "does issue" : "do issues"} ${listed(rest)})`;
        return { ok: false, reason: `issue ${missing[0]} has no finding${nor}`, fix: `Add a finding and a proposed fix for issue ${missing[0]}: it has no finding${nor}.` };
      }
      return { ok: true, reason: ids.length === 0 ? "the reconciliation has no difference to cover" : `every difference (${ids.join(", ")}) has a finding` };
    }
    default:
      return { ok: true, reason: `no coverage rule for task ${String(task)}` };
  }
}

/** "A", "A and B", "A, B and C". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * One finding the coverage check requires, as a predicate on a finding: its kind (null for any), its subject (null
 * for any) and whether it needs a verdict. orchestrator.ts uses these to restore a required finding the Analyst
 * dropped in a revision, so a draft never loses what coverage asks for.
 */
export type Requirement = { kind: string | null; subject: string | null; verdict: boolean; why: string };

export const meetsRequirement = (finding: Finding, need: Requirement): boolean =>
  (need.kind === null || finding.kind === need.kind) && (need.subject === null || finding.subject === need.subject) && (!need.verdict || finding.verdict !== null);

/** The findings coverage() requires for the task, from this run's rows; empty when the evidence query never ran. */
export function requiredFindings(task: Task, store: ResultStore, asOf: string): Requirement[] {
  switch (task) {
    case "explain_week": {
      const largest = largestHolding(resultsOf(store, "week_moves", asOf).flatMap((result) => result.rows));
      if (largest === undefined) return [];
      const symbol = str(largest.symbol);
      return [{ kind: null, subject: symbol, verdict: false, why: `${symbol} is the largest move of the week, and the coverage check requires a finding on it` }];
    }
    case "thesis_check": {
      const ids = [...new Set(resultsOf(store, "journal_for_symbol", asOf).flatMap((result) => result.rows.map((row) => str(row.id))).filter((id) => id !== ""))];
      return ids.map((id) => ({ kind: "thesis", subject: id, verdict: true, why: `the coverage check requires one thesis finding with a verdict for ${id}` }));
    }
    case "pre_trade":
      return [{ kind: "pre_trade", subject: null, verdict: false, why: "the coverage check requires a pre_trade finding" }];
    case "reconcile": {
      const ids = [...new Set(resultsOf(store, "reconciliation").flatMap((result) => result.rows.map((row) => str(row.issue_id))).filter((id) => id !== ""))];
      return ids.map((id) => ({ kind: "reconciliation", subject: id, verdict: false, why: `the coverage check requires a reconciliation finding for issue ${id}` }));
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The fixes code writes for the first two checks.

const REFUSED = /^(?:the claim has|the number) (\d+(?:\.\d+)?)\b/;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Every number in a result's rows, numbers inside strings too (the owner's "Sell if it gains 10%"), as positive values. */
function numbersOf(value: unknown, ignore: readonly string[], out: number[] = [], depth = 0): number[] {
  if (depth > 8) return out;
  if (typeof value === "number" && Number.isFinite(value)) out.push(Math.abs(value));
  else if (typeof value === "string") out.push(...numbersIn(value, ignore));
  else if (Array.isArray(value)) for (const item of value) numbersOf(item, ignore, out, depth + 1);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) numbersOf(item, ignore, out, depth + 1);
  return out;
}

/**
 * Where a refused figure is, so the fix is one the Analyst can act on: the results of this run (at most two) that
 * hold it as the check reads a row (the same value, or that value rounded to one decimal place) and the finding does
 * not cite, or none. A hint only: the check itself is unchanged, and the finding still has to cite the row.
 */
/** Each result's numbers, read once per evaluate (whereIs asks for them once per refused figure). */
type NumbersByResult = ReadonlyMap<string, readonly number[]>;

function numbersByResult(store: ResultStore): NumbersByResult {
  const ids = Object.keys(store);
  return new Map(Object.values(store).map((result) => [result.run_query_id, numbersOf(result.rows, ids)]));
}

function whereIs(value: number, cites: readonly string[], store: ResultStore, numbers: NumbersByResult): string {
  const of = (result: QueryResult) => numbers.get(result.run_query_id) ?? [];
  const holders = Object.values(store).filter((result) => !cites.includes(result.run_query_id) && of(result).some((n) => Math.abs(n - value) < 1e-9 || Math.abs(round1(n) - value) < 1e-9));
  if (holders.length === 0) {
    // A figure rounded the wrong way (2.2 for 2.25, 7259 for 7259.4): name the row value it most likely came from.
    for (const result of Object.values(store)) {
      const near = of(result).find((n) => Math.abs(n - value) < 0.1 || (Number.isInteger(value) && Math.round(n) === value && n !== value));
      if (near !== undefined) return `no result of this run holds ${value}; ${result.query_id} ${result.run_query_id} has ${near}: write it as the row gives it or rounded half up to one decimal place, or leave it out`;
    }
    return `no result of this run holds ${value}, so leave it out`;
  }
  const named = holders.slice(0, 2).map((result) => `${result.query_id} ${result.run_query_id}`);
  return `${value} is in ${listed(named)}${holders.length > 2 ? ` and ${holders.length - 2} more` : ""}: cite the one it came from, or leave it out`;
}

/**
 * Every failure, grouped by finding in the draft's order: no problem is left out of the fix. With `numbers`, each
 * refused figure says where it is in this run, or that it is nowhere; without, the fix names the problems only.
 */
function citationFix(findings: readonly Finding[], failures: readonly { finding: number; problem: string }[], store: ResultStore, numbers: NumbersByResult | null): string {
  const byFinding = new Map<number, string[]>();
  for (const failure of failures) {
    const value = failure.problem.match(REFUSED);
    const finding = findings[failure.finding - 1];
    const hint = value === null || finding === undefined || numbers === null ? "" : ` (${whereIs(Number(value[1]), finding.cites, store, numbers)})`;
    const problems = byFinding.get(failure.finding) ?? [];
    // The same refused figure twice in one claim is one problem.
    if (!problems.includes(`${failure.problem}${hint}`)) problems.push(`${failure.problem}${hint}`);
    byFinding.set(failure.finding, problems);
  }
  return [...byFinding.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, problems]) => {
      const finding = findings[number - 1];
      const who = finding === undefined ? `finding ${number}` : `finding ${number} (${finding.kind} ${finding.subject})`;
      return `Fix ${who}: ${problems.join("; ")}; use only figures from the rows it cites.`;
    })
    .join(" ");
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
  const rejectByCode = (failed: readonly CodeCheck[], flagged: number[]): EvaluateOutcome => {
    // Every failed check's fix, in check order, so the Analyst sees every open problem in one round.
    const fix = failed.map((check) => check.fix ?? "").filter((text) => text !== "").join(" ");
    tracer.log({
      agent_name: AGENT,
      action: "reject",
      input_summary: inputSummary,
      output_summary: capped(`rejected by code (${failed.map((check) => check.check).join(", ")}): ${failed.map((check) => check.reason).join("; ")}; no model call`),
      target_agent: target,
      status: "rejected",
      why: fix,
      confidence: 0,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    return { accepted: false, scores: null, total: 0, confidence: 0, fix, flagged, code_checks: checks, target_agent: target, model: null };
  };

  // The three code checks always all run, in this order, before any model call: a draft that fails more than one is
  // rejected once with every problem named.
  // 1. Every number is in a cited row of this run (or in a listed memory).
  const citations = checkCitations(findings, input.results, memories, tracer, input.as_of);
  const citationCheck: CodeCheck = citations.ok
    ? { check: "citations", ok: true, reason: "every finding cites a result of this run and every number is in the cited rows", fix: null }
    : { check: "citations", ok: false, reason: citations.reason, fix: citationFix(findings, citations.failures, input.results, numbersByResult(input.results)) };

  // 2. No advice, every finding matches the schema, a verdict where the task needs one. The draft is the Analyst's reply.
  const guard = afterModel("Analyst", { findings, gaps }, { task: input.task }, tracer);
  const guardCheck: CodeCheck = guard.ok
    ? { check: "guard", ok: true, reason: `the draft passes the reply guard${guard.injection_seen ? " (injection wording seen)" : ""}`, fix: null }
    : { check: "guard", ok: false, reason: guard.reason, fix: guardFix(guard.reason) };

  // 3. The task's required findings are there.
  const covered = coverage(input.task, findings, input.results, input.as_of);
  const coverageCheck: CodeCheck = covered.ok ? { check: "coverage", ok: true, reason: covered.reason, fix: null } : { check: "coverage", ok: false, reason: covered.reason, fix: covered.fix };

  // The fix goes into the Planner's and the Analyst's prompts: past MAX_FIX_CHARS the refused-figure hints go, and
  // every problem stays named.
  const others = [guardCheck, coverageCheck].filter((check) => !check.ok).reduce((n, check) => n + (check.fix?.length ?? 0) + 1, 0);
  if (!citationCheck.ok && (citationCheck.fix?.length ?? 0) + others > cfg.MAX_FIX_CHARS) citationCheck.fix = citationFix(findings, citations.failures, input.results, null);
  traceCheck(citationCheck);
  traceCheck(guardCheck);
  traceCheck(coverageCheck);

  const failed = [citationCheck, guardCheck, coverageCheck].filter((check) => !check.ok);
  if (failed.length > 0) {
    // The findings a check failed: the citation failures by number, and each finding the guard refuses on its own.
    const flagged = new Set(citations.failures.map((failure) => failure.finding));
    if (!guard.ok) {
      for (const [index, finding] of findings.entries()) if (!afterModel("Analyst", { findings: [finding] }, { task: input.task }).ok) flagged.add(index + 1);
    }
    return rejectByCode(failed, [...flagged].sort((a, b) => a - b));
  }

  // 4. The fast model scores the draft, seeing only the rows the findings cite. A draft of more than
  // EVALUATOR_BATCH_SIZE findings is scored in consecutive batches, one call after another, so no prompt nears
  // MAX_PROMPT_CHARS; code combines the batch scores.
  const inputFor = (chunk: Finding[], first: boolean): EvaluatorInput => ({
    task: input.task,
    question: input.question,
    as_of: input.as_of,
    memories: first ? memoriesForModel(memories, cfg.MAX_MEMORIES) : [],
    findings: chunk,
    gaps: first ? gaps : [],
    results: input.task === "thesis_check" ? citedResultsForSubjects(chunk, input.results, cfg.MAX_ROWS_PER_QUERY) : citedResults(chunk, input.results, cfg.MAX_ROWS_PER_QUERY),
  });
  // One call while the whole prompt is short; batches only when it is long, so a small draft scores as it always did.
  const oneCallChars = JSON.stringify(inputFor(findings, true)).length;
  const chunks = oneCallChars <= (deps.batchAboveChars ?? EVALUATOR_SINGLE_CALL_MAX_CHARS) ? [findings] : batchesOf(findings, EVALUATOR_BATCH_SIZE);
  const chunkScores: { scores: Scores; total: number; fix: string; offset: number }[] = [];
  let model: NonNullable<EvaluateOutcome["model"]> | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const first = index === 0;
    const offset = index * EVALUATOR_BATCH_SIZE;
    const user = inputFor(chunk, first);
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
      // goes to the Writer unscored, whichever batch failed. Any other error passes through as before.
      const noAnswer = error instanceof ModelHttpError && error.status === 502;
      if (!noAnswer && !(error instanceof BadJson)) throw error;
      // A batch that already scored below the pass mark still rejects the draft: a later batch failing never turns that into an accept.
      const failedBatches = chunkScores.filter((c) => c.total < PASS_TOTAL);
      if (failedBatches.length > 0) {
        const own: Scores = {
          accuracy: Math.min(...chunkScores.map((c) => c.scores.accuracy)),
          appropriateness: Math.min(...chunkScores.map((c) => c.scores.appropriateness)),
          actionability: Math.min(...chunkScores.map((c) => c.scores.actionability)),
        };
        const total = own.accuracy + own.appropriateness + own.actionability;
        const fix = combineBatchFixes(failedBatches.filter((c) => c.fix !== ""), cfg.MAX_FIX_CHARS) || fallbackFix(input.task, own);
        tracer.log({
          agent_name: AGENT,
          action: "reject",
          input_summary: inputSummary,
          output_summary: capped(`accuracy=${own.accuracy} appropriateness=${own.appropriateness} actionability=${own.actionability} total=${total} of ${MAX_TOTAL}; a later batch got no score; fix: ${fix}`),
          target_agent: target,
          status: "rejected",
          why: fix,
          confidence: confidenceOf(total),
          retry_count: round,
          duration_ms: Date.now() - started,
        });
        return { accepted: false, scores: own, total, confidence: confidenceOf(total), fix, flagged: namedIn(fix, findings), code_checks: checks, target_agent: target, model };
      }
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
      return { accepted: true, scores: null, total: null, confidence: null, fix: "", flagged: [], code_checks: checks, target_agent: "Writer", model: null };
    }
    run?.afterModelCall(result);
    model = addedModel(model, result);
    const spent = model;

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
      return { accepted: false, scores: null, total: 0, confidence: 0, fix: "", flagged: [], code_checks: checks, target_agent: target, model: spent, error };
    };

    const parsed = scoreSchema.safeParse(result.json ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return badReply({ type: "BadJson", message: `The reply does not match the Evaluator schema (${issue.path.join(".") || "reply"}: ${issue.message}).`, recoverable: true });
    }
    const replyGuard = afterModel(AGENT, parsed.data, { task: input.task }, tracer);
    if (!replyGuard.ok) return badReply({ type: "Blocked", message: replyGuard.reason, recoverable: true });

    const own: Scores = { accuracy: parsed.data.accuracy, appropriateness: parsed.data.appropriateness, actionability: parsed.data.actionability };
    chunkScores.push({ scores: own, total: own.accuracy + own.appropriateness + own.actionability, fix: parsed.data.fix.trim(), offset });
  }

  // The lowest score per dimension across the batches, summed; the pass rule is unchanged.
  const scores: Scores = {
    accuracy: Math.min(...chunkScores.map((c) => c.scores.accuracy)),
    appropriateness: Math.min(...chunkScores.map((c) => c.scores.appropriateness)),
    actionability: Math.min(...chunkScores.map((c) => c.scores.actionability)),
  };
  const total = scores.accuracy + scores.appropriateness + scores.actionability;
  const confidence = confidenceOf(total);
  const accepted = total >= PASS_TOTAL;
  // The fixes of the batches that did not pass on their own, with finding numbers made global.
  const batchFix = combineBatchFixes(
    chunkScores.filter((c) => c.total < PASS_TOTAL && c.fix !== ""),
    cfg.MAX_FIX_CHARS,
  );
  const fix = accepted ? "" : batchFix || fallbackFix(input.task, scores);
  const batches = chunks.length > 1 ? `; scored in ${chunks.length} batches` : "";

  tracer.log({
    agent_name: AGENT,
    action: accepted ? "accept" : "reject",
    input_summary: inputSummary,
    output_summary: capped(`accuracy=${scores.accuracy} appropriateness=${scores.appropriateness} actionability=${scores.actionability} total=${total} of ${MAX_TOTAL}${batches}${accepted ? "" : `; fix: ${fix}`}`),
    target_agent: accepted ? "Writer" : target,
    status: accepted ? "accepted" : "rejected",
    ...(accepted ? {} : { why: fix }),
    confidence,
    model: model!.model_id,
    retry_count: round,
    duration_ms: Date.now() - started,
  });
  return { accepted, scores, total, confidence, fix, flagged: accepted ? [] : namedIn(fix, findings), code_checks: checks, target_agent: accepted ? "Writer" : target, model };
}

/** `items` as consecutive chunks of at most `size`; one chunk (the list itself) when it fits, and for an empty list. */
function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out.length === 0 ? [[...items]] : out;
}

/** The outcome's model after one more call: usage and duration summed, id and source from the latest call. */
function addedModel(before: EvaluateOutcome["model"], result: CompleteResult): NonNullable<EvaluateOutcome["model"]> {
  const usage =
    before === null
      ? result.usage
      : before.usage === null
        ? result.usage
        : result.usage === null
          ? before.usage
          : {
              tokens_in: before.usage.tokens_in + result.usage.tokens_in,
              tokens_out: before.usage.tokens_out + result.usage.tokens_out,
              ...(before.usage.estimate === undefined && result.usage.estimate === undefined ? {} : { estimate: Boolean(before.usage.estimate || result.usage.estimate) }),
            };
  return {
    model_id: result.model_id,
    source: result.source,
    usage,
    duration_ms: (before?.duration_ms ?? 0) + result.duration_ms,
    ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
  };
}

const FINDING_LIST = /\b(findings? )(\d+(?:(?:\s*,\s*|\s+(?:and|or)\s+|\s*&\s*)\d+)*)/gi;
// A sentence that points at a source: a run_query_id, or a figure said to be in another cited result.
const SOURCE_HINT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\bis in\b.*\bcite\b|\b(?:different|another|other|wrong)\s+(?:cited\s+)?(?:result|source|query|row)|\bmismatch/i;

/** Every finding number a text names, in the shapes namedIn reads. */
const findingNumbersIn = (text: string): number[] => [...text.matchAll(FINDING_LIST)].flatMap((match) => match[2].match(/\d+/g)!.map(Number));

/**
 * The fixes of the batches that did not pass, as one fix for the Analyst, in plain code. Finding numbers become
 * global (globalFindingNumbers). Sentences are ordered by the lowest finding number each names (a sentence that
 * names none sorts at the start of its batch), and a sentence word-for-word the same as one already kept is dropped,
 * except a sentence that names a source (a run_query_id, a figure in another cited result), which is kept once per
 * finding. Past maxChars whole sentences are cut from the end, and one sentence says how many findings that left out.
 */
export function combineBatchFixes(parts: readonly { fix: string; offset: number }[], maxChars: number): string {
  const ordered: { text: string; key: number; at: number }[] = [];
  for (const part of parts) {
    for (const raw of globalFindingNumbers(part.fix, part.offset).split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const text = raw.trim();
      if (text === "") continue;
      const numbers = findingNumbersIn(text);
      ordered.push({ text, key: numbers.length > 0 ? Math.min(...numbers) : part.offset + 0.5, at: ordered.length });
    }
  }
  ordered.sort((a, b) => a.key - b.key || a.at - b.at);
  const seen = new Set<string>();
  const sentences = ordered.filter(({ text, key }) => {
    const id = SOURCE_HINT.test(text) ? `${key}|${text}` : text;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (let kept = sentences.length; kept >= 1; kept--) {
    const head = sentences.slice(0, kept).map((sentence) => sentence.text).join(" ");
    if (kept === sentences.length) {
      if (head.length <= maxChars || kept === 1) return head;
      continue;
    }
    const named = new Set(findingNumbersIn(head));
    const left = new Set(sentences.slice(kept).flatMap((sentence) => findingNumbersIn(sentence.text)).filter((n) => !named.has(n)));
    const note = left.size > 0 ? `${left.size} more finding${left.size === 1 ? " was" : "s were"} left out; fix the ones above first.` : "More points were left out; fix the ones above first.";
    const text = `${head} ${note}`;
    if (text.length <= maxChars || kept === 1) return text;
  }
  return "";
}

/**
 * A batch's fix names findings by their place in that batch; add the batch's start offset so each number is the
 * finding's place in the whole draft: "finding 2" with offset 10 is "finding 12", "findings 2, 4 or 5" is
 * "findings 12, 14 or 15". The same list shapes namedIn reads.
 */
export function globalFindingNumbers(fix: string, offset: number): string {
  if (offset === 0) return fix;
  return fix.replace(FINDING_LIST, (_all, label: string, list: string) => `${label}${list.replace(/\d+/g, (n) => String(Number(n) + offset))}`);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The findings a model's fix names, by number counting from 1: "finding 3", or the finding's subject as a whole word
 * (BXPHARMA, j-013, Pharmaceuticals & Chemicals). A finding the fix does not name is kept into the next draft by code.
 */
export function namedIn(fix: string, findings: readonly Finding[]): number[] {
  // "finding 3", "findings 2 and 3", "findings 2, 4 or 5": every number in the list.
  const numbers = new Set([...fix.matchAll(/\bfindings? (\d+(?:(?:\s*,\s*|\s+(?:and|or)\s+|\s*&\s*)\d+)*)/gi)].flatMap((match) => match[1].match(/\d+/g)!.map(Number)));
  const out: number[] = [];
  for (const [index, finding] of findings.entries()) {
    // A subject counts only as the target of a finding ("the GP finding", "BXPHARMA's claim", "the finding on GP"),
    // not in passing ("compare with BXPHARMA").
    const s = `(?<![A-Za-z0-9_-])${escaped(finding.subject)}(?![A-Za-z0-9_-])`;
    const asTarget = new RegExp(`${s}(?:'s)?\\s+(?:\\w+\\s+)?(?:finding|claim)s?\\b|\\b(?:finding|claim)s?\\s+(?:on|about|for|of)\\s+${s}`, "i");
    if (numbers.has(index + 1) || asTarget.test(fix)) out.push(index + 1);
  }
  return out;
}
