// The bounded loop: one run of one task. Code resolves as_of once, seeds and recalls memory, then runs the Planner,
// the Analyst and the Evaluator up to MAX_ROUNDS times, branching in code: a draft that passes the code checks and
// scores 7 or more of 9 goes to the Writer; a rejected draft goes back to the Planner with the fix as feedback and
// to the Analyst with its previous findings and the fix. Every budget in config.ts (rounds, query calls, model
// calls, tokens, round and run time) is checked before each call; when one runs out the run returns needs_human
// with the best draft, output.partial and output.stop_reason. run() never throws: a typed error from llm.ts or an
// agent becomes { status: "error", error, usage }. Every result that is not an error carries usage, and the last
// trace line of every run is the Orchestrator's run_end line with the run's total usage. Server only (node:fs
// through trace.ts, memory.ts and queries.ts).
import path from "node:path";
import { analyse, type AnalysisOutcome, type FlaggedFinding } from "./agents/analyst";
import { evaluate, requiredFindings, type Scores } from "./agents/evaluator";
import { defaultPlanFor, PlanBlockedError, plan, type PlannedStep, type PlannerTrade, type PlanOutcome, type PlanRequest } from "./agents/planner";
import { route } from "./agents/router";
import { DISCLAIMER, write } from "./agents/writer";
import { BRIEFING_MIN_CHILD_MS, ConfigError, loadConfig, type Config, type Tier } from "./config";
import { runWithLimit } from "./concurrency";
import { TASKS, type Task } from "./context";
import { injectionIn, type Finding } from "./guards";
import { MODEL_UNAVAILABLE_LABEL, PLANNER_FALLBACK_LABEL, STOP_REASONS } from "./labels";
import { BadJson, failedCallUsage, ModelError, ModelHttpError, ModelNetworkError, ModelTimeout, PromptTooLarge, RateLimited, type AgentName } from "./llm";
import { learnCorrection, MemoryBlockedError, recall, rememberDecision, seedOwnerContext, withMiner, type RecalledMemory } from "./memory";
import { branchOnWhatIf, fixedPlan, PRE_TRADE_FOCUS, resolveTrade, type PreTradeEscalation } from "./pre-trade";
import { register, release } from "./registry";
import { dropRepeatFailures, keyOf, knownSubjects, mergeRevision, passesCodeChecks, type CodeNote, type Retraction } from "./revision";
import { QueryBlockedError, QueryError, type QueryId, type QueryResult, type QuerySource, type Row } from "./queries";
import { APPROVE_REFUSED, canApply, editFor, proposalsFrom, proposedFix, reconcilePlan, RECONCILE_FOCUS, ZETARIS_STALE, type LedgerEdit, type Proposal } from "./reconcile-fix";
import { BudgetExhaustedError, RunState, type Usage } from "./run-state";
import { batchesToRerun, findingsOfBatch, keepThesisSteps, prepareThesisEvidence, THESIS_BATCH_SIZE, type PreparedTheses } from "./thesis";
import { isRunId, startRun, type Tracer } from "./trace";
import { about as worldAbout, recordRun, type WorldAbout } from "./world";
import { appendContribution, loadContributions } from "@/lib/data";
import type { Rules } from "@/lib/data-types";
import { buildPortfolioView, resolveAsOf } from "@/lib/portfolio-view";
import { readJson } from "@/lib/store";
import { appendTransaction, loadTransactions } from "@/lib/transactions";

const AGENT = "Orchestrator";
const GUARD = "Guard";
const SUMMARY_CHARS = 200;


/** The tasks this loop runs today; later steps add the others. */
const SUPPORTED: readonly Task[] = ["explain_week", "thesis_check", "pre_trade", "reconcile"];
/** The owner's correction to a review: stored in H-MEM by code, with no Planner and no loop. */
const FEEDBACK = "feedback";
/** The owner's approval of one reconciliation fix: applied by code from the current rows, with no model. */
const APPROVE = "reconcile_approve";
/** The weekly briefing: explain_week, thesis_check and reconcile as three whole runs, chained by briefing(). */
const BRIEFING = "briefing";

// ---------------------------------------------------------------------------------------------------------------
// The request and the reply.

export type RunInput = {
  /** Required for explain_week; a missing question is "" for every other task. */
  question?: string;
  /** A yyyy-mm-dd date, resolved to a session with resolveAsOf; the latest session when absent, for every task. */
  as_of?: string | null;
  trade?: PlannerTrade | null;
  /** Fields later tasks read; each task checks the ones it needs when it is added. */
  plan_id?: string;
  review_run_id?: string;
  text?: string;
  /** feedback only: the ids of recalled memories the owner says were wrong; each gets hmem.feedback(id, "wrong"). */
  wrong_memory_ids?: string[];
  /** reconcile_approve only: the issue_id of the reconciliation row the owner approves. */
  issue_id?: string;
};

/** A run id the API accepts: it becomes part of logs/trace-<run_id>.jsonl, so no dot or separator. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export type RunOptions = {
  runId: string;
  /** When missing, the Router reads the question and picks the task. An unknown name is an InvalidInput error reply, never a throw. */
  task?: string;
  input: RunInput;
  /** Default config.sampleMode. */
  sampleMode?: boolean;
  /** Default loadConfig(). Passed to every agent and so to every complete() call. */
  config?: Config;
  /** Set when every query must run locally (an eval fixture data dir that is not in Postgres): the trace's reason. */
  localReason?: string;
  /**
   * A caller's cancel signal, combined with the run's own (the registry's) through AbortSignal.any. A briefing passes
   * its signal to each child, so cancelling the briefing stops the children that are running.
   */
  signal?: AbortSignal;
  /** The briefing that started this run; the registry does not count a run with a parent against MAX_CONCURRENT_RUNS. */
  parentRunId?: string;
};

export type StopReason = (typeof STOP_REASONS)[number];
export type RunStatus = "success" | "needs_human" | "error";

/** One cited result: what the accepted findings rest on. `rows` (at most CITATION_ROWS) is for the Explain page's drawer; it is output only and never goes into a model's input. */
export type Citation = { run_query_id: string; query_id: QueryId; params: Record<string, unknown>; source: QuerySource; row_count: number; rows: QueryResult["rows"]; /** The SQL Zetaris ran, when source is "zetaris". */ sql?: string; /** briefing only: the child run whose findings cite it. */ child_run_id?: string };
export const CITATION_ROWS = 50;
export type RunScores = Scores & { total: number };

export type RunOutput = {
  summary: string;
  review_markdown: string;
  findings: Finding[];
  gaps: string[];
  citations: Citation[];
  needs_human: boolean;
  declined_advice: boolean;
  injection_seen: boolean;
  memories_recalled: { id: string; tags: string[] }[];
  applied_corrections: { id: string; content: string }[];
  /** The round the draft was accepted in, or the rounds run. */
  rounds: number;
  /** From the last Evaluator call; null when it rejected the draft in code, never ran, or had no score (score_unavailable). */
  scores: RunScores | null;
  /** "sample-model", or the model ids the replies reported; never a key or a URL. */
  model_source: string;
  partial: boolean;
  stop_reason: StopReason | null;
  /** thesis_check only: one entry per thesis that has a finding, in journal order. */
  verdicts?: ThesisVerdict[];
  /** pre_trade only: the distinct kinds of the rule findings the trade would newly cause, such as ["sector_target"]; [] when none. */
  new_findings?: string[];
  /** pre_trade only: the first new rule finding, decided in code; null when the trade breaks no rule. */
  escalation?: PreTradeEscalation | null;
  /** feedback only: the ids of the memories the correction added. */
  memory_ids_added?: string[];
  /** reconcile only: one proposal per difference, built by code from the reconciliation rows, each awaiting approval. */
  proposals?: Proposal[];
  /** reconcile_approve only: what the approval did; null when nothing was written. */
  applied?: { issue_id: string; edit: LedgerEdit; memory_id: string | null } | null;
  /** briefing only: one entry per child run, in chain order. */
  sections?: BriefingSection[];
};

/** One child of a briefing. "skipped" means the child never started because less than BRIEFING_MIN_CHILD_MS was left. */
export type BriefingSection = { task: string; run_id: string; status: RunStatus | "skipped"; summary: string; stop_reason: StopReason | null; usage: RunUsage };
/** Runs one child of a briefing: run() by default, a stub in a test. */
export type RunChild = (options: RunOptions) => Promise<RunResult>;

export type ThesisVerdict = { journal_id: string; symbol: string; verdict: string; cites: string[] };

export type RunError = { type: string; message: string; recoverable: boolean };
export type AgentInfo = { name: AgentName; role: string; model: string };
export type RunUsage = Usage & { duration_ms: number };

export type RunResult = {
  run_id: string;
  task: string;
  status: RunStatus;
  output: RunOutput | null;
  error: RunError | null;
  agents: AgentInfo[];
  usage: RunUsage;
  trace_id: string;
  /** logs/trace-<run_id>.jsonl, relative to the project; null when the run id was refused before a file existed. */
  log_file: string | null;
  execution_time_seconds: number;
};

const AGENTS: readonly { name: AgentName; role: string; tier: Tier }[] = [
  { name: "Planner", role: "picks at most MAX_PLAN_STEPS named queries for the task, with a why for each", tier: "strong" },
  { name: "Analyst", role: "turns the plan's query results into findings that cite a run_query_id for every number", tier: "main" },
  { name: "Evaluator", role: "checks citations, the guard and coverage in code, then scores the draft out of 9", tier: "fast" },
  { name: "Writer", role: "writes the owner's review from the accepted findings; code checks every number", tier: "strong" },
  { name: "Router", role: "picks the task for a question that names none; it never answers", tier: "fast" },
];

/** The agents as the reply lists them: in sample mode every model is "sample-model", else the tier's routing id. */
export function agentsOf(config: Config, sampleMode: boolean): AgentInfo[] {
  return AGENTS.map(({ name, role, tier }) => ({ name, role, model: sampleMode ? "sample-model" : (config.models[tier] ?? "unset") }));
}

// A question that asks whether to trade, decided in code so the flag holds in sample mode too.
const ADVICE_QUESTION = [
  /\b(should|shall|could|can|do|would|must|ought to) i (just |also |now |still |rather )?(buy|sell|hold|trim|dump|exit|add)\b/i,
  /\bgo ahead and (buy|sell)\b/i,
  /\b(buy|sell|hold) (now|more|it|them|everything|all|out)\b/i,
  /\btime to (buy|sell)\b/i,
  /\bbuy or sell\b/i,
];

/** True when the question asks whether to buy, sell or hold ("should I sell", "go ahead and buy"). */
export function asksForAdvice(question: string): boolean {
  return ADVICE_QUESTION.some((pattern) => pattern.test(question));
}

const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const REMOVED = "[removed: text that reads like an instruction to the agents]";

/** thesis_check: one entry per thesis that has a thesis finding, in journal order. */
export function verdictsOf(findings: readonly Finding[], theses: readonly { journal_id: string; symbol: string }[]): ThesisVerdict[] {
  return theses.flatMap(({ journal_id, symbol }) => {
    const found = findings.find((finding) => finding.kind === "thesis" && finding.subject === journal_id);
    return found === undefined || found.verdict === null ? [] : [{ journal_id, symbol, verdict: found.verdict, cites: [...found.cites] }];
  });
}

/**
 * The rule that sends a finished run to the owner: the first new rule finding of a pre_trade, or "reconcile_proposals"
 * for a reconciliation with differences. Undefined for a run that did not end escalated.
 */
function escalationRuleOf(outcome: { kind: string }, preTrade: { escalation: PreTradeEscalation | null } | null, reconciliation: QueryResult | null): string | undefined {
  if (outcome.kind !== "escalated") return undefined;
  if (preTrade?.escalation != null) return preTrade.escalation.rule;
  return reconciliation !== null ? "reconcile_proposals" : undefined;
}

/** The cited results of the findings, each once, in the order first cited. */
export function citationsOf(findings: readonly Finding[], store: Record<string, QueryResult>): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const finding of findings) {
    for (const cite of finding.cites) {
      const result = store[cite];
      if (result === undefined || seen.has(cite)) continue;
      seen.add(cite);
      out.push({ run_query_id: cite, query_id: result.query_id, params: result.params, source: result.source, row_count: result.rows.length, rows: result.rows.slice(0, CITATION_ROWS), ...(result.source === "zetaris" && result.sql !== undefined ? { sql: result.sql } : {}) });
    }
  }
  return out;
}

/** A review written by code, never a model, for a run that stopped before the Writer: the draft and why it stopped. */
export function draftReview(findings: readonly Finding[], gaps: readonly string[], reason: string): string {
  const lines = [reason, ""];
  if (findings.length === 0) lines.push("No findings were drafted before the run stopped.");
  for (const finding of findings) lines.push(`- ${finding.claim} ${finding.cites.map((id) => `[q:${id}]`).join(" ")}`.trimEnd());
  if (gaps.length > 0) lines.push("", `Not covered: ${gaps.join("; ")}`);
  lines.push("", DISCLAIMER);
  return lines.join("\n");
}

function stopText(reason: StopReason, config: Config, detail: string): string {
  switch (reason) {
    case "rounds":
      return `The draft was not accepted after ${config.MAX_ROUNDS} rounds; the last fix asked: ${detail} The findings below are the best draft, unreviewed; the decision is yours.`;
    case "query_calls":
      return `The run stopped: its query budget (${config.MAX_QUERY_CALLS} calls) was spent. The findings below are the best draft, unreviewed.`;
    case "model_calls":
      return `The run stopped: its model budget (${config.MAX_MODEL_CALLS} calls) was spent. The findings below are the best draft, unreviewed.`;
    case "tokens":
      return `The run stopped: its token budget (${config.MAX_TOKENS_PER_RUN} tokens) was spent. The findings below are the best draft, unreviewed.`;
    case "round_timeout":
      return `The run stopped: a round passed ROUND_TIMEOUT_MS (${config.ROUND_TIMEOUT_MS} ms). The findings below are the best draft, unreviewed.`;
    case "run_timeout":
      return `The run stopped: it passed RUN_TIMEOUT_MS (${config.RUN_TIMEOUT_MS} ms). The findings below are the best draft, unreviewed.`;
    case "writer_rejected":
      return `The Writer's review failed its code check twice: ${detail}`;
    case "model_unavailable":
      return `The model did not answer, so no model wrote or checked this review: ${detail}`;
    case "cancelled":
      return "The run was stopped by you. The findings below are the best draft so far, unreviewed; nothing was remembered or saved.";
  }
}

/** The error reply for a typed error from llm.ts or an agent. Recoverable: a timeout, a 429 or a 5xx; nothing else. */
export function errorOf(error: unknown): RunError {
  // A query that refuses its parameters (an unknown symbol, no price, a rejected trade) is the caller's input, never a 500.
  if (error instanceof QueryError && error.type !== "unknown_query") return { type: "InvalidInput", message: error.message, recoverable: false };
  if (error instanceof ModelTimeout) return { type: "ModelTimeout", message: error.message, recoverable: true };
  if (error instanceof RateLimited) return { type: "RateLimited", message: error.message, recoverable: true };
  if (error instanceof ModelHttpError) return { type: "ModelHttpError", message: error.message, recoverable: error.status !== undefined && error.status >= 500 };
  if (error instanceof ModelError || error instanceof ConfigError) return { type: error.name, message: error.message, recoverable: false };
  if (error instanceof PlanBlockedError) return { type: "PlanBlocked", message: error.message, recoverable: false };
  if (error instanceof Error) return { type: "Internal", message: error.message, recoverable: false };
  return { type: "Internal", message: String(error), recoverable: false };
}

/** The Planner failures the code plan stands in for, in the review's words (no figures, so the Writer's check is unaffected). */
const PLANNER_FALLBACK_WORDS = {
  bad_json: "its replies could not be read",
  upstream: "the model service returned an error",
  timeout: "the model call timed out",
  rate_limited: "the model service was busy and refused the call",
  network: "the model service could not be reached",
} as const;

/**
 * A model failure that llm.ts gave up on and a fallback may stand in for: BadJson after its structured tries, a 5xx
 * after its empty_response or transport retry, a timeout or a 429 after its one retry, or a ModelNetworkError (a real
 * network failure: a reset connection, a DNS failure, a socket timeout) after its one retry. Never Unauthorized,
 * NightshiftNotRunning (Nightshift not started), PromptTooLarge, a 4xx other than 429, a ModelHttpError with no status
 * that is not a network failure (a TypeError or other bug from the SDK), a cancel or a spent budget.
 */
function isModelFailure(error: unknown): boolean {
  return (
    error instanceof BadJson ||
    error instanceof ModelTimeout ||
    error instanceof RateLimited ||
    error instanceof ModelNetworkError ||
    (error instanceof ModelHttpError && error.status !== undefined && error.status >= 500)
  );
}

/**
 * Why the Planner's failed call gets the code plan, or null when it must pass through: a model failure llm.ts gave up
 * on (isModelFailure). A timeout counts only while the round and the run still have time (`timeLeft`); otherwise the
 * loop ends with round_timeout or run_timeout. `code` is the trace's cause: bad_json, upstream_<status>, timeout,
 * rate_limited or network.
 */
export function plannerFallbackCause(error: unknown, timeLeft: boolean): { kind: keyof typeof PLANNER_FALLBACK_WORDS; code: string; detail: string } | null {
  if (!isModelFailure(error)) return null;
  if (error instanceof BadJson) return { kind: "bad_json", code: "bad_json", detail: `${error.kind}: ${error.reason}` };
  if (error instanceof ModelTimeout) return timeLeft ? { kind: "timeout", code: "timeout", detail: error.message } : null;
  if (error instanceof RateLimited) return { kind: "rate_limited", code: "rate_limited", detail: error.message };
  if (error instanceof ModelNetworkError) return { kind: "network", code: "network", detail: error.message };
  const http = error as ModelHttpError;
  return { kind: "upstream", code: `upstream_${http.status}`, detail: http.message };
}

// ---------------------------------------------------------------------------------------------------------------
// Injection: rows, memories and trade-plan notes are data, scanned in code; a match is traced and its text removed.

function flagInjection(tracer: Tracer, what: string, pattern: string): void {
  tracer.log({
    agent_name: GUARD,
    action: "injection_flagged",
    input_summary: capped(what),
    output_summary: `reads like an instruction to the agents (matched ${pattern}); its text is removed from what every model and the Writer see`,
    status: "blocked",
    why: "injection wording in data",
  });
}

/** Every string cell that reads like an instruction is replaced; the row's numbers stay. Returns the flagged count. */
function scrubResult(result: QueryResult, tracer: Tracer, onFlag: () => void): QueryResult {
  let changed = false;
  const rows = result.rows.map((row, index) => {
    let out: QueryResult["rows"][number] | null = null;
    for (const [field, cell] of Object.entries(row)) {
      if (typeof cell !== "string") continue;
      const pattern = injectionIn(cell);
      if (pattern === null) continue;
      out ??= { ...row };
      out[field] = REMOVED;
      changed = true;
      onFlag();
      flagInjection(tracer, `${result.query_id} row ${index + 1}, field ${field}`, pattern);
    }
    return out ?? row;
  });
  return changed ? { ...result, rows } : result;
}

/** The memories whose content reads like an instruction are left out of every model input and of the reply. */
function scrubMemories(memories: readonly RecalledMemory[], tracer: Tracer): { kept: RecalledMemory[]; flagged: number } {
  const kept: RecalledMemory[] = [];
  let flagged = 0;
  for (const memory of memories) {
    const pattern = injectionIn(memory.content);
    if (pattern === null) {
      kept.push(memory);
      continue;
    }
    flagged += 1;
    flagInjection(tracer, `memory ${memory.id} (tags ${memory.tags.join(",")})`, pattern);
  }
  return { kept, flagged };
}

/** The trade-plan notes in rules.json of the data dir: a note that reads like an instruction sets the flag. */
async function flaggedTradePlans(tracer: Tracer): Promise<number> {
  const rules = await readJson<Rules | null>("rules", null);
  let flagged = 0;
  for (const tradePlan of rules?.trade_plans ?? []) {
    const pattern = tradePlan.note === null ? null : injectionIn(tradePlan.note);
    if (pattern === null) continue;
    flagged += 1;
    flagInjection(tracer, `trade plan ${tradePlan.id} note (rules.json)`, pattern);
  }
  return flagged;
}

// ---------------------------------------------------------------------------------------------------------------
// run

/** The newer draft replaces the best one when it scored higher, or when neither has a score. */
function betterDraft(draft: Draft, best: Draft): boolean {
  if (draft.scores === null && best.scores === null) return true;
  return draft.total !== null && (best.total === null || draft.total > best.total);
}

/** total is null when the Evaluator accepted the draft unscored (score_unavailable). */
type Draft = { findings: Finding[]; gaps: string[]; /** The gaps code wrote, in forms that hold only code text and validated names: the only gap text whose figures the Writer may repeat. */ code_gaps: string[]; scores: Scores | null; total: number | null; round: number; /** True when no draft existed and this one only carries the code plan's gap. */ planOnly?: true };

/** How a stop or cancel line names the draft the run returns. */
function draftWords(draft: Draft | null): string {
  if (draft === null) return "no draft";
  if (draft.planOnly === true) return "no draft; plan from code";
  return `the best draft (${draft.findings.length} findings, ${draft.total === null ? "score unavailable" : `total ${draft.total}`})`;
}

/** What the loop ends with, before the reply is built. `rounds` is the round accepted in, or the rounds run. */
type NeedsHuman = { kind: "needs_human"; stop: StopReason; detail: string; draft: Draft | null; rounds: number; summary?: string; review_markdown?: string };
type Outcome =
  | { kind: "success"; summary: string; review_markdown: string; draft: Draft; rounds: number }
  /** pre_trade: the trade would newly break a rule. A finished review for the owner to decide on, not a stopped run. */
  | { kind: "escalated"; summary: string; review_markdown: string; draft: Draft; rounds: number }
  | NeedsHuman
  /** feedback: the correction was stored; no draft, no Writer. */
  | { kind: "feedback"; summary: string; memory_ids_added: string[] }
  /** reconcile_approve: one fix applied by code (success), or nothing written and the owner told why (needs_human). */
  | { kind: "approval"; status: "success" | "needs_human"; summary: string; applied: NonNullable<RunOutput["applied"]> | null }
  | { kind: "error"; error: RunError };

/**
 * Runs one task to a reply. The budgets are checked before every call, each model call gets the time left as its
 * timeout, and a budget that runs out ends the run as needs_human with the best draft (the highest total so far, or
 * the last draft when no round reached the model). The run's usage adds up every model call and every real query
 * call; the Orchestrator's run_end line, the last line of the run, repeats the total.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { runId } = options;
  // A run id the checks refuse never registers: runLoop answers it with the InvalidInput error and no trace file.
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !isRunId(runId)) return runLoop(options, new AbortController().signal);
  // The registry's signal is the run's own; a caller's signal (a briefing's) is combined with it. Released however the run ends.
  const own = register({ run_id: runId, task: options.task ?? "auto", parent_run_id: options.parentRunId ?? null });
  const signal = options.signal === undefined ? own : AbortSignal.any([own, options.signal]);
  try {
    return await runLoop(options, signal);
  } finally {
    release(runId, own);
  }
}

async function runLoop(options: RunOptions, signal: AbortSignal): Promise<RunResult> {
  const started = Date.now();
  const { runId } = options;
  /** The request's input; a routed pre_trade gets the trade the Router built from the question. */
  let input = options.input;
  /** True when the request names no task: the Router picks one after the input checks. */
  const routing = options.task === undefined;
  /** The request's task, or "explain_week" until the Router replaces it; the reply and the run_end line carry the final one. */
  let taskName = options.task ?? "explain_week";
  const config = options.config ?? loadConfig();
  const sampleMode = options.sampleMode ?? config.sampleMode;
  const agents = agentsOf(config, sampleMode);
  const seconds = () => Math.round(Date.now() - started) / 1000;

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !isRunId(runId)) {
    const usage: RunUsage = { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: Date.now() - started };
    return {
      run_id: String(runId),
      task: taskName,
      status: "error",
      output: null,
      error: { type: "InvalidInput", message: `Invalid run id: ${JSON.stringify(String(runId))}.`, recoverable: false },
      agents,
      usage,
      trace_id: String(runId),
      log_file: null,
      execution_time_seconds: seconds(),
    };
  }

  // The briefing is a fixed chain of whole runs with its own trace, not a loop of its own.
  if (options.task === BRIEFING) return briefing({ ...options, signal });

  // Before the Router has picked, its own line carries task "router"; setTask after it only changes later lines.
  const tracer = startRun(runId, { task: routing ? "router" : taskName });
  const logFile = path.relative(process.cwd(), tracer.file);
  const flags = { declined: false, injection: false };
  let run: RunState | undefined;
  let asOf: string | null = null;
  let memories: RecalledMemory[] = [];
  /** World Model facts about the holdings involved, given to the Planner and the Analyst. */
  let world: WorldAbout[] = [];
  /** feedback: the miner's model usage; the other tasks count in the RunState. */
  let feedbackUsage: Usage | null = null;
  /** From the last Evaluator call: null when it rejected in code, or never ran. */
  let lastScores: RunScores | null = null;
  let lastConfidence: number | null = null;
  /** thesis_check: the journal ids and symbols of the theses checked, in journal order. */
  let thesisIds: { journal_id: string; symbol: string }[] = [];
  /** pre_trade: what the what_if rows decided in code. */
  let preTrade: { new_findings: string[]; escalation: PreTradeEscalation | null } | null = null;
  /** reconcile: the reconciliation result the proposals are built from. */
  let reconciliation: QueryResult | null = null;
  const modelIds = new Set<string>();

  const declineAdvice = (by: string) => {
    if (flags.declined) return;
    flags.declined = true;
    tracer.log({
      agent_name: GUARD,
      action: "advice_declined",
      input_summary: capped(`question of ${typeof input.question === "string" ? input.question.length : 0} chars`),
      output_summary: `the question asks whether to buy, sell or hold (${by}); the review explains the records and declines the advice`,
      status: "ok",
      why: "no output tells the owner to buy, sell or hold",
    });
  };

  /** The one "cancelled" trace line of a run, and the outcome that ends it: like a spent limit, with the best draft so far. */
  let cancelLogged = false;
  const cancelledOutcome = (draft: Draft | null, rounds: number, where: string): NeedsHuman => {
    if (!cancelLogged) {
      cancelLogged = true;
      tracer.log({
        agent_name: AGENT,
        action: "cancelled",
        input_summary: capped(where),
        output_summary: capped(`cancelled: the run returns needs_human with ${draftWords(draft)}; nothing is remembered or recorded`),
        status: "needs_human",
        why: "cancelled by the owner",
        retry_count: Math.max(0, rounds - 1),
        stop_reason: "cancelled",
      });
    }
    return { kind: "needs_human", stop: "cancelled", detail: "cancelled by the owner", draft, rounds };
  };

  let outcome: Outcome;
  try {
    outcome = await execute();
  } catch (error) {
    // An abort that surfaced outside the loop's own try (as_of, memory recall) still ends the run as cancelled, never as an error.
    outcome = signal.aborted ? cancelledOutcome(null, 1, "before the loop finished its set-up") : { kind: "error", error: errorOf(error) };
  }

  // An accepted run is recorded in the World Model from its query results, never from model text.
  if ((outcome.kind === "success" || outcome.kind === "escalated") && run !== undefined && asOf !== null) await recordWorld(run, asOf, outcome.draft.findings);

  const usage: RunUsage = { ...(run?.usage ?? feedbackUsage ?? { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0 }), duration_ms: Date.now() - started };
  const result = reply(outcome, usage);
  tracer.setTask(taskName);
  const escalationRule = escalationRuleOf(outcome, preTrade, reconciliation);
  tracer.log({
    agent_name: AGENT,
    action: "run_end",
    input_summary: capped(`task=${taskName} as_of=${asOf ?? "unresolved"} sample_mode=${sampleMode}`),
    output_summary: capped(
      result.status === "error"
        ? `status=error type=${result.error?.type}: ${result.error?.message}`
        : `status=${result.status}${result.output?.stop_reason ? ` stop_reason=${result.output.stop_reason}` : ""} rounds=${result.output?.rounds} findings=${result.output?.findings.length} citations=${result.output?.citations.length} declined_advice=${result.output?.declined_advice} injection_seen=${result.output?.injection_seen}`,
    ),
    status: result.status === "success" ? "ok" : result.status,
    ...(result.status === "error" ? { why: result.error?.message } : result.output?.stop_reason ? { why: result.output.stop_reason } : {}),
    confidence: lastConfidence,
    retry_count: Math.max(0, (result.output?.rounds ?? 1) - 1),
    duration_ms: usage.duration_ms,
    ...(result.output?.stop_reason ? { stop_reason: result.output.stop_reason } : {}),
    // The review queue reads these two fields from this line alone: why a needs_human run waits for the owner.
    ...(escalationRule === undefined ? {} : { escalation_rule: escalationRule }),
    usage,
  });
  return result;

  // The run, start to finish. Throws only what the catch above turns into an error reply.
  async function execute(): Promise<Outcome> {
    const invalid = (message: string): Outcome => ({ kind: "error", error: { type: "InvalidInput", message, recoverable: false } });
    if (taskName === FEEDBACK || taskName === APPROVE) {
      if (input === null || typeof input !== "object") return invalid("The input must be an object.");
      return taskName === FEEDBACK ? feedbackRun() : approveRun();
    }
    if (typeof taskName !== "string" || !TASKS.includes(taskName as Task)) {
      return invalid(`Unknown task ${JSON.stringify(taskName)}; the tasks are ${[...TASKS, FEEDBACK, APPROVE].join(", ")}.`);
    }
    let task = taskName as Task;
    if (!SUPPORTED.includes(task)) return invalid(`Task ${JSON.stringify(task)} is not supported yet; this loop runs ${[...SUPPORTED, FEEDBACK, APPROVE].join(", ")}.`);
    if (input === null || typeof input !== "object") return invalid("The input must be an object.");
    if (input.question !== undefined && input.question !== null && typeof input.question !== "string") return invalid("The question must be a string.");
    if (input.as_of !== undefined && input.as_of !== null && typeof input.as_of !== "string") return invalid("as_of must be a date as YYYY-MM-DD.");
    // The question is required for explain_week only; every other task gets "" when it has none.
    const question = (input.question ?? "").trim();
    if (task === "explain_week" && question === "") return invalid("The question is empty.");

    const flagRow = () => {
      flags.injection = true;
    };
    run = new RunState({ runId, tracer, config, sampleMode, signal, ...(options.localReason === undefined ? {} : { localReason: options.localReason }), onResult: (fresh) => scrubResult(fresh, tracer, flagRow) });
    const state = run;

    // 1. Time and budget, before the first model call (the Router's).
    const runDeadline = started + config.RUN_TIMEOUT_MS;
    let roundStarted = started;
    const runLeft = () => runDeadline - Date.now();
    const roundLeft = () => roundStarted + config.ROUND_TIMEOUT_MS - Date.now();
    const timeLeft = (tier: Tier) => Math.max(0, Math.min(tier === "strong" ? config.MODEL_TIMEOUT_STRONG_MS : config.MODEL_TIMEOUT_MS, roundLeft(), runLeft()));
    // When the round ends, or the run if sooner: llm.ts retries a 502 empty_response only while a whole call still fits.
    const roundDeadline = () => Math.min(roundStarted + config.ROUND_TIMEOUT_MS, runDeadline);
    const budgetStop = (needsQueries: boolean): StopReason | null => {
      // Checked before every agent call, query, tool round and round: a stopped run makes no further call.
      if (signal.aborted) return "cancelled";
      if (runLeft() <= 0) return "run_timeout";
      if (roundLeft() <= 0) return "round_timeout";
      if (state.usage.model_calls >= config.MAX_MODEL_CALLS) return "model_calls";
      if (state.tokens() >= config.MAX_TOKENS_PER_RUN) return "tokens";
      if (needsQueries && state.usage.query_calls >= config.MAX_QUERY_CALLS) return "query_calls";
      return null;
    };
    // A planned step that the spent query budget kept from running leaves a draft on part of the evidence.
    const cutByBudget = (steps: readonly PlannedStep[]): boolean => steps.some((step) => state.queryBudgetSpentFor(step.query_id, step.params));
    const stopDetail = (reason: StopReason): string => {
      switch (reason) {
        case "model_calls":
          return `${state.usage.model_calls} of ${config.MAX_MODEL_CALLS} model calls used`;
        case "tokens":
          return `${state.tokens()} of ${config.MAX_TOKENS_PER_RUN} tokens used`;
        case "query_calls":
          return `${state.usage.query_calls} of ${config.MAX_QUERY_CALLS} query calls used`;
        case "cancelled":
          return "cancelled by the owner";
        case "round_timeout":
          return `${Date.now() - roundStarted} ms into the round, limit ${config.ROUND_TIMEOUT_MS} ms`;
        case "run_timeout":
          return `${Date.now() - started} ms into the run, limit ${config.RUN_TIMEOUT_MS} ms`;
        default:
          return reason;
      }
    };

    // 2. as_of, once. Every input, trace line and memory tag uses the resolved date.
    const data = await state.queryData();
    const resolved = resolveAsOf(data.portfolio.bars, input.as_of ?? null);
    if (!resolved.ok) return { kind: "error", error: { type: "InvalidInput", message: resolved.error, recoverable: false } };
    asOf = resolved.asOf;
    if (input.as_of && input.as_of !== asOf) {
      tracer.log({
        agent_name: GUARD,
        action: "as_of_moved",
        input_summary: `as_of ${input.as_of}`,
        output_summary: `as_of moved from ${input.as_of} to ${asOf}`,
        status: "ok",
        why: "as_of is not a session: the Thursday before a Friday or Saturday, or the last session on or before the date",
      });
    }
    // 3. Router, only when the request has no task (the input checks above ran with explain_week). It is the run's first
    // model call and counts in usage and in MAX_MODEL_CALLS. A reply it cannot use routes to explain_week and never ends
    // the run; any other model failure is the run's typed error.
    if (routing) {
      const early = budgetStop(false);
      if (early !== null) {
        tracer.log({
          agent_name: AGENT,
          action: "stop",
          input_summary: "before the Router",
          output_summary: capped(`${early}: ${stopDetail(early)}; the run returns needs_human with no draft`),
          status: "needs_human",
          why: early,
          stop_reason: early,
        });
        return { kind: "needs_human", stop: early, detail: stopDetail(early), draft: null, rounds: 1 };
      }
      state.beforeModelCall();
      const routed = await route(
        { question, plan_id: input.plan_id || null, instruments: [...data.portfolio.instruments.values()] },
        { tracer, config, sampleMode, signal, timeoutMs: timeLeft("fast"), roundDeadlineMs: roundDeadline(), modelCallsLeft: state.modelCallsLeft(), tokensLeft: state.tokensLeft() },
      ).catch((error: unknown): never => {
        state.afterFailedModelCall(failedCallUsage(error));
        throw error;
      });
      if (routed.model !== null) {
        state.afterModelCall(routed.model);
        modelIds.add(routed.model.model_id);
      }
      if (routed.failed !== null) state.afterFailedModelCall(routed.failed);
      task = routed.task;
      taskName = routed.task;
      // The second setTask: it only changes the task written on later lines, never the file.
      tracer.setTask(task);
      // A routed pre_trade carries the trade built from the question, unless the request gave its own trade.
      if (routed.trade !== null && (input.trade === undefined || input.trade === null)) input = { ...input, trade: routed.trade };
    }

    // pre_trade: the trade is validated in code before any model call; a bad trade never reaches a model.
    let trade: PlannerTrade | null = null;
    let planId: string | null = null;
    if (task === "pre_trade") {
      const rules = await readJson<Rules | null>("rules", null);
      const resolvedTrade = resolveTrade(input, { hasSymbol: (symbol) => data.portfolio.instruments.has(symbol), plans: rules?.trade_plans ?? [] });
      if (!resolvedTrade.ok) return invalid(resolvedTrade.message);
      trade = resolvedTrade.trade;
      planId = resolvedTrade.plan_id;
    }
    tracer.log({
      agent_name: AGENT,
      action: "run_start",
      input_summary: capped(`task=${task} question ${question.length} chars as_of=${asOf}${trade ? ` trade=${trade.side} ${trade.quantity} ${trade.symbol}${trade.price === undefined ? "" : ` at ${trade.price}`}${planId ? ` (plan ${planId})` : ""}` : ""}`),
      output_summary: `sample_mode=${sampleMode}; limits: ${config.MAX_ROUNDS} rounds, ${config.MAX_QUERY_CALLS} query calls, ${config.MAX_MODEL_CALLS} model calls, ${config.MAX_TOKENS_PER_RUN} tokens, ${config.ROUND_TIMEOUT_MS} ms a round, ${config.RUN_TIMEOUT_MS} ms a run`,
      status: "ok",
    });

    // 4. Memory: the owner's context once, then what this question recalls, scanned in code.
    await seedOwnerContext(tracer);
    const recalled = await recall(trade === null ? question : `${question} ${trade.symbol} ${trade.side}`.trim(), asOf, tracer);
    const scrubbed = scrubMemories(recalled, tracer);
    memories = scrubbed.kept;
    if (scrubbed.flagged > 0) flags.injection = true;
    if ((await flaggedTradePlans(tracer)) > 0) flags.injection = true;
    if (asksForAdvice(question)) declineAdvice("matched in code");
    world = worldFor(buildPortfolioView(data.portfolio, asOf).holdings.map((holding) => holding.symbol), trade?.symbol);

    /** The highest total so far; among drafts no model scored, the latest. */
    let best: Draft | null = null;
    /** The last Analyst reply, scored or not: what a stop before the Evaluator returns. */
    let latest: Draft | null = null;
    let accepted: Draft | null = null;
    let feedback: string | null = null;
    let previous: Finding[] | null = null;
    /** The findings of `previous` that the last rejection flagged; code carries every other one into the next draft. */
    let flagged: ReadonlySet<Finding> = new Set();
    /** Each flagged finding's number as the fix gives it: its place in the whole rejected draft, every batch counted. */
    let flaggedNumber: ReadonlyMap<Finding, number> = new Map();
    /**
     * The gaps code wrote about findings it dropped or kept despite a retraction, for the rest of the run: keyed by scope
     * ("draft", or "batch <n>" for thesis_check) and the finding's kind and subject. Each stays while it is true.
     */
    const codeNotes = new Map<string, Map<string, CodeNote>>();
    /** thesis_check: the evidence, the plan's focus and each batch's findings and gaps, kept across rounds. */
    let thesis: { prepared: PreparedTheses; focus: string; /** The planner_fallback gap, when code made the plan. */ note: string | null; found: (Finding[] | null)[]; gapsBy: string[][]; codeGapsBy: string[][] } | null = null;
    let stop: StopReason | null = null;
    let round = 0;
    /** The agent whose model call is running, so a model failure can name it. */
    let calling: AgentName = "Planner";
    /** The planner_fallback gap of the plan in use, or null when the Planner made it. */
    let planNote: string | null = null;
    /**
     * The draft a stopped run returns, carrying the planner_fallback gap when the plan in use came from code, so a
     * stop before the Analyst's draft (a 502, a timeout, a spent budget) still says the plan was code's.
     */
    const bestDraft = (): Draft | null => {
      const draft = accepted ?? best ?? latest;
      if (planNote === null || (draft?.gaps ?? []).includes(planNote)) return draft;
      if (draft === null) return { findings: [], gaps: [planNote], code_gaps: [planNote], scores: null, total: null, round, planOnly: true };
      return { ...draft, gaps: [...draft.gaps, planNote], code_gaps: [...draft.code_gaps, planNote] };
    };
    const roundsRun = () => Math.min(round + 1, config.MAX_ROUNDS);
    const stopped = (reason: StopReason, detail = stopDetail(reason)): NeedsHuman => {
      const draft = bestDraft();
      if (reason === "cancelled") return cancelledOutcome(draft, roundsRun(), `round ${roundsRun()} of ${config.MAX_ROUNDS}`);
      tracer.log({
        agent_name: AGENT,
        action: "stop",
        input_summary: `round ${roundsRun()} of ${config.MAX_ROUNDS}`,
        output_summary: capped(`${reason}: ${detail}; the run returns needs_human with ${draftWords(draft)}`),
        status: "needs_human",
        why: reason,
        retry_count: Math.min(round, config.MAX_ROUNDS - 1),
        stop_reason: reason,
      });
      return { kind: "needs_human", stop: reason, detail, draft, rounds: roundsRun() };
    };

    /**
     * The findings in `prior` that the last rejection flagged, for the Analyst's input: each with the number the fix
     * gives it (the whole draft's numbering, so a thesis batch's finding 26 is 26 here too), its kind and its subject.
     */
    const flaggedIn = (prior: readonly Finding[] | null): FlaggedFinding[] | null =>
      prior === null ? null : prior.flatMap((finding) => (flagged.has(finding) ? [{ finding: flaggedNumber.get(finding) ?? 0, kind: finding.kind, subject: finding.subject }] : []));

    /** Unnamed drops so far in the run, so each one's gap gets its own ordinal word ("the second one"). */
    let unnamedDrops = 0;

    /**
     * The code notes of one scope that still hold for `findings`. A drop note holds while the draft has no more
     * findings with that kind and subject that pass the code checks than it had when the finding was dropped: another
     * finding with the same key (B, passing, next to the dropped A) never clears it, nor does the same finding coming
     * back still failing; only one written again that passes. A kept-despite-retraction note holds while that exact
     * finding is in the draft. Returns their gaps.
     */
    const notesFor = (scope: string, findings: readonly Finding[], added: readonly CodeNote[]): string[] => {
      const notes = codeNotes.get(scope) ?? new Map<string, CodeNote>();
      for (const note of added) notes.set(`${note.kind}\u0000${note.key}\u0000${note.gap}`, note);
      const passing = (key: string) => findings.filter((finding) => keyOf(finding) === key && passesCodeChecks(finding, task, state.store, memories, resolved.asOf)).length;
      for (const [id, note] of notes) {
        const holds = note.kind === "dropped" ? passing(note.key) <= (note.survivors ?? 0) : findings.includes(note.finding);
        if (!holds) notes.delete(id);
      }
      codeNotes.set(scope, notes);
      return [...new Set([...notes.values()].map((note) => note.gap))];
    };

    /**
     * Revise, don't restart (revision.ts): on a retry, the Analyst's new findings merged with `prior`, the draft the
     * Evaluator rejected. Every previous finding code keeps (carried, or restored because coverage requires it) and
     * every retraction gets its own Orchestrator line, so the trace says which findings code put back and why. A
     * flagged finding that comes back still failing the code checks is dropped (dropRepeatFailures) unless coverage
     * needs it, with a "drop_finding" line and a gap written by code. `gaps` holds every code note of the scope that
     * still holds, this round's and earlier rounds' (notesFor), so a later accepted round keeps saying what code did.
     * The gaps come back as code_gaps, so they name only validated symbols, sectors and required ids; the trace lines
     * may name the raw subject, because nothing reads a trace line's text as allowed figures.
     */
    const revised = (next: Finding[], retracted: readonly Retraction[], prior: readonly Finding[] | null, scope = "draft"): { findings: Finding[]; gaps: string[] } => {
      if (prior === null || prior.length === 0) return { findings: next, gaps: notesFor(scope, next, []) };
      const required = requiredFindings(task, state.store, resolved.asOf);
      const known = knownSubjects(data.portfolio.instruments.values(), state.store);
      for (const need of required) if (need.subject !== null) known.add(need.subject);
      const asOfDay = resolved.asOf;
      const merged = mergeRevision({ task, previous: prior, flagged, next, retracted, required, store: state.store, memories, asOf: asOfDay, known });
      for (const gone of retracted) {
        tracer.log({
          agent_name: AGENT,
          action: "retracted",
          input_summary: capped(`round ${round + 1}: ${gone.kind} ${gone.subject}`),
          output_summary: capped(`the Analyst retracted the previous ${gone.kind} finding on ${gone.subject}, so code does not carry it`),
          target_agent: "Evaluator",
          status: "ok",
          why: capped(gone.why === "" ? "no reason given" : gone.why),
          retry_count: round,
        });
      }
      for (const entry of merged.kept) {
        tracer.log({
          agent_name: AGENT,
          action: entry.how === "restored" ? "restore_finding" : "carry_forward",
          input_summary: capped(`round ${round + 1}: previous finding ${entry.was} (${entry.finding.kind} ${entry.finding.subject}), missing from the Analyst's ${next.length} new findings`),
          output_summary: capped(`${entry.how === "restored" ? "restored" : "carried forward"} by code, unchanged; the draft has ${merged.findings.length} findings`),
          target_agent: "Evaluator",
          status: "ok",
          why: capped(entry.why),
          retry_count: round,
        });
      }
      const kept = dropRepeatFailures({ task, flagged, findings: merged.findings, required, store: state.store, known, memories, asOf: asOfDay, firstOrdinal: unnamedDrops + 1 });
      unnamedDrops += kept.dropped.filter((gone) => gone.unnamed).length;
      for (const gone of kept.dropped) {
        tracer.log({
          agent_name: AGENT,
          action: "drop_finding",
          input_summary: capped(`round ${round + 1}: ${gone.finding.kind} ${gone.finding.subject}, flagged last round`),
          output_summary: capped(`left out by code: it still fails the code checks after the fix, and coverage does not need it; the draft has ${kept.findings.length} findings and a gap says so`),
          target_agent: "Evaluator",
          status: "rejected",
          why: capped(gone.gap),
          retry_count: round,
        });
      }
      const added: CodeNote[] = [...merged.notes, ...kept.dropped.map((gone): CodeNote => ({ key: keyOf(gone.finding), gap: gone.gap, finding: gone.finding, kind: "dropped", survivors: gone.survivors }))];
      return { findings: kept.findings, gaps: notesFor(scope, kept.findings, added) };
    };

    /**
     * A model failure after the queries ran: the best draft so far, a review built in code, one fallback line. A
     * BadJson here means the model answered on every try but no reply could be read, which the review says.
     */
    const modelUnavailable = (error: ModelError): NeedsHuman => {
      const type = errorOf(error).type;
      const unreadable = error instanceof BadJson;
      const ran = Object.values(state.store).map((result) => result.query_id);
      const detail = `${type} in the ${calling}'s call (${error.message}); ${ran.length} queries ran: ${ran.join(", ")}.`;
      const base = bestDraft();
      const oversized = error instanceof PromptTooLarge;
      const gap = `The ${calling}'s ${unreadable ? "model replies could not be read" : oversized ? "prompt was too large for the model" : "model call failed"} (${type}), so ${calling === "Writer" ? "no review was written" : "the draft was not completed or checked"}.`;
      const draft: Draft = { findings: base?.findings ?? [], gaps: [...(base?.gaps ?? []), gap], code_gaps: [...(base?.code_gaps ?? []), gap], scores: base?.scores ?? null, total: base?.total ?? null, round: base?.round ?? round };
      tracer.log({
        agent_name: AGENT,
        action: "model_unavailable_fallback",
        input_summary: capped(`round ${roundsRun()} of ${config.MAX_ROUNDS}; ${calling} call failed: ${type}`),
        output_summary: capped(`the run returns needs_human with ${draft.findings.length} findings from ${base === null ? "no draft" : "the best draft"} and the ${ran.length} cached query results`),
        target_agent: null,
        status: "fallback",
        why: `${type} from the ${calling}'s model call after ${ran.length} queries ran: ${error.message}`,
        retry_count: Math.min(round, config.MAX_ROUNDS - 1),
        stop_reason: "model_unavailable",
      });
      const reply = unreadable ? "answered, but none of its replies could be read" : oversized ? "was sent a prompt over MAX_PROMPT_CHARS" : "did not answer";
      const summary = `${MODEL_UNAVAILABLE_LABEL}. The model ${reply} (${type}, in the ${calling}'s step), so this draft comes from ${ran.length} query results. Nothing was reviewed or scored.`;
      const lines = [summary, "", `Queries that ran: ${ran.join(", ")}.`, ""];
      if (draft.findings.length === 0) lines.push("No findings were drafted before the model stopped answering.");
      for (const finding of draft.findings) lines.push(`- ${finding.claim} ${finding.cites.map((id) => `[q:${id}]`).join(" ")}`.trimEnd());
      lines.push("", `Not covered: ${draft.gaps.join("; ")}`, "", DISCLAIMER);
      return { kind: "needs_human", stop: "model_unavailable", detail, draft, rounds: roundsRun(), summary, review_markdown: lines.join("\n") };
    };

    /**
     * The Planner's call, counted here (plan() has no run of its own, so every request it made is counted, failed or
     * not). When it still fails after llm.ts gives up (plannerFallbackCause: replies that cannot be read, a 5xx such
     * as the 502 empty_response, a timeout that is not the round's or the run's, a 429 or a network error), code builds the task's
     * default plan (default-plan.ts, through the Planner's own step checks), writes one Orchestrator "planner_fallback"
     * line with the cause in its why, and the run carries on to the Analyst. `note` is the gap that says so in the
     * review. Every other error (Unauthorized, NightshiftNotRunning, a spent budget, a cancel) passes through.
     */
    const planOrFallback = async (request: PlanRequest): Promise<{ focus: string; steps: PlannedStep[]; note: string | null }> => {
      state.beforeModelCall();
      calling = "Planner";
      let planned: PlanOutcome;
      try {
        planned = await plan(request, { tracer, config, sampleMode, signal, timeoutMs: timeLeft("strong"), roundDeadlineMs: roundDeadline(), modelCallsLeft: state.modelCallsLeft(), tokensLeft: state.tokensLeft(), round });
      } catch (error) {
        state.afterFailedModelCall(failedCallUsage(error));
        const cause = signal.aborted ? null : plannerFallbackCause(error, runLeft() > 0 && roundLeft() > 0);
        if (cause === null) throw error;
        const fallback = defaultPlanFor(request, config, new Set(data.portfolio.instruments.keys()));
        const ids = fallback.steps.map((step) => step.query_id);
        const note = `${PLANNER_FALLBACK_LABEL} (${PLANNER_FALLBACK_WORDS[cause.kind]}; queries: ${ids.join(", ")}); the review covers those, not a plan made for this question.`;
        tracer.log({
          agent_name: AGENT,
          action: "planner_fallback",
          input_summary: capped(`round ${round + 1} of ${config.MAX_ROUNDS}; task=${request.task}; the Planner's call failed: ${cause.code}`),
          output_summary: capped(`${fallback.steps.length} steps planned in code, no model: ${ids.join(", ") || "none"}${fallback.dropped.length > 0 ? `; ${fallback.dropped.length} dropped` : ""}`),
          target_agent: "Analyst",
          status: "fallback",
          why: `${cause.code} after llm.ts gave up (${cause.detail}); the plan: ${fallback.steps.map((step, index) => `${index + 1}. ${step.query_id}: ${step.why}`).join(" ")}`,
          retry_count: round,
        });
        planNote = note;
        return { focus: fallback.focus, steps: fallback.steps, note };
      }
      state.afterModelCall(planned.model);
      modelIds.add(planned.model.model_id);
      if (planned.injection_seen) flags.injection = true;
      if (planned.declined_advice) declineAdvice("flagged by the Planner");
      planNote = null;
      return { focus: planned.focus, steps: planned.steps, note: null };
    };

    try {
      // pre_trade is a fixed chain: its evidence never changes, so code builds the plan (the Planner is not called),
      // traces it, runs what_if first and branches on its rows. The other four queries run in the Analyst's step.
      let fixed: PlannedStep[] = [];
      if (task === "pre_trade" && trade !== null) {
        fixed = fixedPlan(trade, asOf);
        tracer.log({
          agent_name: AGENT,
          action: "fixed_plan",
          input_summary: capped(`task=pre_trade ${trade.side} ${trade.quantity} ${trade.symbol} as_of=${asOf}`),
          output_summary: capped(`${fixed.length} steps, no Planner call: ${fixed.map((step) => step.query_id).join(", ")}`),
          target_agent: "Analyst",
          status: "ok",
          why: fixed.map((step, index) => `${index + 1}. ${step.query_id}: ${step.why}`).join(" "),
        });
        stop = budgetStop(true);
        if (stop !== null) return stopped(stop);
        let whatIf: QueryResult;
        try {
          whatIf = await state.query(fixed[0].query_id, fixed[0].params, { caller: AGENT, task: "pre_trade" });
        } catch (error) {
          if (error instanceof QueryBlockedError) return invalid(error.reason);
          throw error;
        }
        preTrade = branchOnWhatIf(whatIf);
        tracer.log({
          agent_name: AGENT,
          action: "branch",
          input_summary: capped(`what_if ${whatIf.run_query_id}`),
          output_summary: capped(
            preTrade.escalation === null
              ? "no new rule finding: the review says which rules still hold and what the trade does to the weights"
              : `the trade would newly break ${preTrade.new_findings.join(", ")}; the run escalates to the owner with the review`,
          ),
          target_agent: "Analyst",
          status: "ok",
          why: "decided in code from the what_if rows, never by a model",
          ...(preTrade.escalation === null ? {} : { escalation_rule: preTrade.escalation.rule }),
        });
      }
      // reconcile is a fixed chain too: code runs reconciliation (Zetaris, with the local fallback), then plans the
      // journal of each symbol a trade difference names. The Planner is not called; a rejection goes to the Analyst.
      if (task === "reconcile") {
        tracer.log({
          agent_name: AGENT,
          action: "fixed_plan",
          input_summary: capped(`task=reconcile as_of=${asOf}`),
          output_summary: "no Planner call: reconciliation first, then journal_for_symbol for each symbol a trade difference names",
          target_agent: "Analyst",
          status: "ok",
          why: "1. reconciliation: every difference between the ledger and the broker and bank files. 2. journal_for_symbol: the owner's journal for each symbol a trade difference names.",
        });
        stop = budgetStop(true);
        if (stop !== null) return stopped(stop);
        try {
          reconciliation = await state.query("reconciliation", {}, { caller: AGENT, task: "reconcile" });
        } catch (error) {
          if (error instanceof QueryBlockedError) return invalid(error.reason);
          throw error;
        }
        const planned = reconcilePlan(reconciliation.rows, asOf, config.MAX_PLAN_STEPS);
        fixed = planned.steps;
        const ids = reconciliation.rows.map((row) => String(row.issue_id));
        tracer.log({
          agent_name: AGENT,
          action: "branch",
          input_summary: capped(`reconciliation ${reconciliation.run_query_id} source=${reconciliation.source}`),
          output_summary: capped(
            `${ids.length} differences (${ids.join(", ") || "none"}); ${fixed.length} steps: ${fixed.map((step) => (step.query_id === "journal_for_symbol" ? `journal_for_symbol ${String(step.params.symbol)}` : step.query_id)).join(", ")}${planned.left_out.length > 0 ? `; no room for the journals of ${planned.left_out.join(", ")}` : ""}`,
          ),
          target_agent: "Analyst",
          status: "ok",
          why: "decided in code from the reconciliation rows, never by a model",
        });
      }

      // 5. The loop.
      rounds: for (round = 0; round < config.MAX_ROUNDS; round += 1) {
        roundStarted = Date.now();

        let findings: Finding[];
        let gaps: string[];
        let codeGaps: string[];
        let cutByQueryBudget = false;
        if (task === "thesis_check") {
          // The plan is made once: code runs the per-symbol queries, so a later round reuses it and the evidence.
          if (thesis === null) {
            stop = budgetStop(false);
            if (stop !== null) break;
            const planned = await planOrFallback({ task, question, as_of: asOf, trade: null, memories, world, feedback });
            stop = budgetStop(true);
            if (stop !== null) break;
            const prepared = await prepareThesisEvidence({ state, tracer, asOf, steps: keepThesisSteps(planned.steps, tracer, round), round });
            thesisIds = prepared.theses.map(({ journal_id, symbol }) => ({ journal_id, symbol }));
            thesis = { prepared, focus: planned.focus, note: planned.note, found: prepared.batches.map(() => null), gapsBy: prepared.batches.map(() => []), codeGapsBy: prepared.batches.map(() => []) };
            tracer.log({
              agent_name: AGENT,
              action: "evidence_built",
              input_summary: `${prepared.theses.length} theses, ${prepared.batches.length} batches of at most ${THESIS_BATCH_SIZE}`,
              output_summary: capped(`${state.usage.query_calls} query calls so far; ${prepared.gaps.length} queries did not run`),
              target_agent: "Analyst",
              status: "ok",
              retry_count: round,
            });
          } else {
            tracer.log({
              agent_name: AGENT,
              action: "plan_reused",
              input_summary: `round ${round + 1} of ${config.MAX_ROUNDS}`,
              output_summary: "the plan and the evidence tables are reused; only the batches that hold a journal id the fix names go back to the Analyst",
              target_agent: "Analyst",
              status: "ok",
              retry_count: round,
            });
          }

          // The Analyst, once per batch of at most THESIS_BATCH_SIZE theses; on a retry only the batches the fix names, the rest keep their findings.
          const rerun: Set<number> = round === 0 || feedback === null ? new Set(thesis.prepared.batches.map((_, index) => index)) : batchesToRerun(feedback, thesis.prepared.batches);
          let unusable: string | null = null;
          for (const [index, batch] of thesis.prepared.batches.entries()) {
            if (thesis.found[index] !== null && !rerun.has(index)) continue;
            stop = budgetStop(false);
            if (stop !== null) break rounds;
            calling = "Analyst";
            const analysis = await analyse(
              { task, question, as_of: asOf, focus: thesis.focus, steps: [], theses: batch, memories, world, previous_findings: thesis.found[index], feedback: round === 0 ? null : feedback, flagged_findings: round === 0 ? null : flaggedIn(thesis.found[index]) },
              { run: state, sampleMode, signal, timeoutMs: timeLeft("main"), roundDeadlineMs: roundDeadline(), round },
            );
            modelIds.add(analysis.model.model_id);
            if (!analysis.ok) {
              thesis.found[index] = null;
              unusable = `The Analyst's reply for batch ${index + 1} was unusable (${analysis.error.type}): ${analysis.error.message} Reply with the JSON object the prompt defines, findings and gaps only.`;
              continue;
            }
            if (analysis.injection_seen) flags.injection = true;
            const { kept, dropped } = findingsOfBatch(batch, analysis.findings);
            if (dropped.length > 0) {
              tracer.log({
                agent_name: AGENT,
                action: "findings_dropped",
                input_summary: `batch ${index + 1} of ${thesis.prepared.batches.length}`,
                output_summary: `dropped ${dropped.length} thesis ${dropped.length === 1 ? "finding" : "findings"} for theses outside the batch (${dropped.map((finding) => finding.subject).join(", ")})`,
                target_agent: "Analyst",
                status: "ok",
                retry_count: round,
              });
            }
            const merged = round === 0 ? { findings: kept, gaps: [] } : revised(kept, analysis.retracted, thesis.found[index], `batch ${index}`);
            thesis.found[index] = merged.findings;
            thesis.gapsBy[index] = [...new Set([...analysis.gaps, ...merged.gaps])];
            thesis.codeGapsBy[index] = [...new Set([...analysis.code_gaps, ...merged.gaps])];
          }
          findings = thesis.found.flatMap((batchFindings) => batchFindings ?? []);
          const planNote = thesis.note === null ? [] : [thesis.note];
          gaps = [...new Set([...thesis.prepared.gaps, ...thesis.gapsBy.flat(), ...planNote])];
          codeGaps = [...new Set([...thesis.prepared.code_gaps, ...thesis.codeGapsBy.flat(), ...planNote])];
          if (unusable !== null) {
            feedback = unusable;
            revise(round, feedback, findings.length);
            continue;
          }
          cutByQueryBudget = thesis.prepared.budget_cut;
        } else if ((task === "pre_trade" && trade !== null) || task === "reconcile") {
          // No Planner: the plan is fixed, so a rejection goes to the Analyst with its previous findings and the fix.
          // The steps come from the cache after round 0, and the Analyst is offered no tools.
          stop = budgetStop(fixed.some((step) => !state.isCached(step.query_id, step.params)));
          if (stop !== null) break;
          calling = "Analyst";
          const analysis: AnalysisOutcome = await analyse(
            { task, question, as_of: asOf, trade, focus: task === "reconcile" ? RECONCILE_FOCUS : PRE_TRADE_FOCUS, steps: fixed, memories, world, previous_findings: previous, feedback, flagged_findings: flaggedIn(previous), noTools: true },
            { run: state, sampleMode, signal, timeoutMs: timeLeft("main"), roundDeadlineMs: roundDeadline(), round },
          );
          modelIds.add(analysis.model.model_id);
          if (!analysis.ok) {
            feedback = `The Analyst's reply was unusable (${analysis.error.type}): ${analysis.error.message} Reply with the JSON object the prompt defines, findings and gaps only.`;
            revise(round, feedback, previous?.length ?? 0);
            continue;
          }
          if (analysis.injection_seen) flags.injection = true;
          const merged = revised(analysis.findings, analysis.retracted, previous);
          findings = merged.findings;
          gaps = [...new Set([...analysis.gaps, ...merged.gaps])];
          codeGaps = [...new Set([...analysis.code_gaps, ...merged.gaps])];
          cutByQueryBudget = cutByBudget(fixed);
        } else {
          // Planner, or the task's default plan when its call fails after llm.ts gives up (BadJson, a 5xx, a timeout,
          // a 429 or a network error). Its call is counted in planOrFallback.
          stop = budgetStop(false);
          if (stop !== null) break;
          const planned = await planOrFallback({ task, question, as_of: asOf, trade: input.trade ?? null, memories, world, feedback });

          // Analyst. The query budget matters only when a planned step is not already in the cache.
          const needsQueries = planned.steps.some((step) => !state.isCached(step.query_id, step.params));
          stop = budgetStop(needsQueries);
          if (stop !== null) break;
          calling = "Analyst";
          const analysis: AnalysisOutcome = await analyse(
            { task, question, as_of: asOf, trade: input.trade ?? null, focus: planned.focus, steps: planned.steps, memories, world, previous_findings: previous, feedback, flagged_findings: flaggedIn(previous) },
            { run: state, sampleMode, signal, timeoutMs: timeLeft("main"), roundDeadlineMs: roundDeadline(), round },
          );
          modelIds.add(analysis.model.model_id);
          if (!analysis.ok) {
            feedback = `The Analyst's reply was unusable (${analysis.error.type}): ${analysis.error.message} Reply with the JSON object the prompt defines, findings and gaps only.`;
            revise(round, feedback, previous?.length ?? 0);
            continue;
          }
          if (analysis.injection_seen) flags.injection = true;
          const merged = revised(analysis.findings, analysis.retracted, previous);
          findings = merged.findings;
          // A plan made in code is said in the review: its note is a gap code wrote, as is each finding code dropped.
          gaps = [...new Set([...analysis.gaps, ...merged.gaps, ...(planned.note === null ? [] : [planned.note])])];
          codeGaps = [...new Set([...analysis.code_gaps, ...merged.gaps, ...(planned.note === null ? [] : [planned.note])])];
          // Stop with that draft instead of scoring it as complete.
          cutByQueryBudget = cutByBudget(planned.steps);
        }
        latest = { findings, gaps, code_gaps: codeGaps, scores: null, total: 0, round };
        if (cutByQueryBudget) {
          stop = "query_calls";
          break;
        }

        // Evaluator: code checks first, then the fast model.
        stop = budgetStop(false);
        if (stop !== null) break;
        calling = "Evaluator";
        const verdict = await evaluate(
          { task, question, as_of: asOf, findings, gaps, memories, results: state.store },
          { tracer, run: state, config, sampleMode, signal, timeoutMs: timeLeft("fast"), roundDeadlineMs: roundDeadline(), round },
        );
        if (verdict.model !== null) modelIds.add(verdict.model.model_id);
        lastConfidence = verdict.model === null ? null : verdict.confidence;
        // A null total (score_unavailable) leaves output.scores null; it is never read as 0.
        lastScores = verdict.scores === null || verdict.total === null ? null : { ...verdict.scores, total: verdict.total };
        const draft: Draft = { ...latest, scores: verdict.scores, total: verdict.total };
        latest = draft;
        if (best === null || betterDraft(draft, best)) best = draft;
        if (verdict.accepted) {
          accepted = draft;
          break;
        }
        feedback = verdict.fix !== "" ? verdict.fix : verdict.error === undefined ? "Revise the draft." : `The Evaluator could not score the draft (${verdict.error.type}): ${verdict.error.message}`;
        previous = findings;
        const numbered = verdict.flagged.flatMap((number): [Finding, number][] => (findings[number - 1] === undefined ? [] : [[findings[number - 1], number]]));
        flagged = new Set(numbered.map(([finding]) => finding));
        flaggedNumber = new Map(numbered);
        revise(round, feedback, previous.length, flagged.size);
      }
      if (stop !== null) return stopped(stop);
      if (accepted === null) return stopped("rounds", feedback ?? "no fix was recorded");

      // 6. The Writer, in the accepted round.
      stop = budgetStop(false);
      if (stop !== null) return stopped(stop);
      calling = "Writer";
      const written = await write(
        {
          task,
          question,
          as_of: asOf,
          findings: accepted.findings,
          results: state.store,
          gaps: accepted.gaps,
          code_gaps: accepted.code_gaps,
          declined_advice: flags.declined,
          escalation: preTrade?.escalation ?? null,
          memories,
          runId,
          // The run's own counts, from code: the Writer's number check allows these and no other new number.
          counts: {
            findings: accepted.findings.length,
            proposals: task === "reconcile" && reconciliation !== null ? proposalsFrom(reconciliation.rows, accepted.findings, reconciliation.run_query_id).length : null,
            citations: citationsOf(accepted.findings, state.store).length,
            rounds: accepted.round + 1,
          },
        },
        { tracer, run: state, config, sampleMode, signal, timeoutMs: timeLeft("strong"), roundDeadlineMs: roundDeadline(), round: accepted.round },
      );
      modelIds.add(written.model.model_id);
      if (written.injection_seen) flags.injection = true;
      if (!written.ok && signal.aborted) return stopped("cancelled");
      if (!written.ok) {
        const detail = written.reason ?? "the review failed its code check";
        return { ...stopped("writer_rejected", detail), summary: written.summary, review_markdown: written.review_markdown };
      }
      const done = { summary: written.summary, review_markdown: written.review_markdown, draft: accepted, rounds: accepted.round + 1 };
      // A reconciliation with differences waits for the owner's approval of each proposal, as an escalated trade does.
      const awaitsOwner = preTrade?.escalation != null || (task === "reconcile" && (reconciliation?.rows.length ?? 0) > 0);
      return { kind: awaitsOwner ? "escalated" : "success", ...done };
    } catch (error) {
      // A call that threw because the run was stopped (the signal's reason, or the SDK's abort error) ends as cancelled, whatever it was.
      if (signal.aborted) return stopped("cancelled");
      // A budget an agent found spent, or a timeout that was the round's or the run's, ends as needs_human.
      if (error instanceof BudgetExhaustedError) return stopped(error.stop_reason === "max_tokens" ? "tokens" : "model_calls", error.message);
      if (error instanceof ModelTimeout) {
        if (runLeft() <= 0) return stopped("run_timeout");
        if (roundLeft() <= 0) return stopped("round_timeout");
      }
      // A model failure llm.ts gave up on (isModelFailure: a 5xx, the 502 empty_response included, a timeout that is not
      // the round's or the run's, a 429, a network error, or replies that still could not be read), after at least one
      // query result is held: keep the evidence and return a code-built draft, never an error.
      if (isModelFailure(error) && Object.keys(state.store).length > 0) return modelUnavailable(error as ModelError);
      // The Analyst's prompt over MAX_PROMPT_CHARS, after analyse() cut what it could (previous findings, tool rounds).
      // Only a system prompt that is over the limit alone still errors: no cut can make that prompt fit.
      if (error instanceof PromptTooLarge && !error.systemAlone && calling === "Analyst" && Object.keys(state.store).length > 0) return modelUnavailable(error);
      throw error;
    }
  }

  /**
   * feedback (A5): the owner's correction goes straight to H-MEM, with no Planner and no loop. The miner's model call
   * runs inside withMiner, so its model_call line and its usage belong to this run.
   */
  async function feedbackRun(): Promise<Outcome> {
    const fail = (message: string): Outcome => ({ kind: "error", error: { type: "InvalidInput", message, recoverable: false } });
    if (signal.aborted) return cancelledOutcome(null, 0, "task=feedback, before the correction was stored");
    if (typeof input.review_run_id !== "string" || input.review_run_id.trim() === "") return fail("review_run_id is required for feedback: the run id of the review this corrects.");
    if (typeof input.text !== "string" || input.text.trim() === "") return fail("text is required for feedback: the correction in the owner's words.");
    const wrongIds = input.wrong_memory_ids ?? [];
    if (!Array.isArray(wrongIds) || wrongIds.some((id) => typeof id !== "string")) return fail("wrong_memory_ids must be a list of memory ids.");
    tracer.log({
      agent_name: AGENT,
      action: "run_start",
      input_summary: capped(`task=feedback review_run_id=${input.review_run_id} text ${input.text.length} chars, ${wrongIds.length} wrong memory ids`),
      output_summary: "no Planner and no loop: the correction goes straight to H-MEM",
      target_agent: "Memory",
      status: "ok",
    });
    const usage: Usage = { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0 };
    feedbackUsage = usage;
    const learned = await withMiner({ tracer, usage, sampleMode, config }, () =>
      learnCorrection({ review_run_id: input.review_run_id as string, text: input.text as string, wrong_memory_ids: wrongIds, tracer }),
    );
    if (!learned.ok) return { kind: "error", error: learned.error };
    asOf = learned.as_of;
    return {
      kind: "feedback",
      summary: `Stored your correction to the review of ${learned.as_of} as ${learned.memory_ids_added.join(", ")}; later reviews recall it by tag.`,
      memory_ids_added: learned.memory_ids_added,
    };
  }

  /**
   * reconcile_approve: the owner approves one proposal. Code reruns the reconciliation query's local() on the files as
   * they are now (source "local", traced), takes the row with the issue_id and applies its edit through src/lib:
   * appendContribution for a bank deposit missing from the contributions, appendTransaction for a broker trade missing
   * from the ledger. The fix never comes from the review run's text or trace; review_run_id is only traced. A manual
   * check writes nothing. It writes only when canApply() allows; then the decision is stored through
   * guards.beforeRemember with kind "decision".
   */
  async function approveRun(): Promise<Outcome> {
    const fail = (message: string): Outcome => ({ kind: "error", error: { type: "InvalidInput", message, recoverable: false } });
    if (typeof input.review_run_id !== "string" || input.review_run_id.trim() === "") return fail("review_run_id is required for reconcile_approve: the run id of the reconcile review the proposal came from.");
    if (typeof input.issue_id !== "string" || input.issue_id.trim() === "") return fail("issue_id is required for reconcile_approve: the issue_id of the proposal you approve.");
    const reviewRunId = input.review_run_id.trim();
    const issueId = input.issue_id.trim();
    tracer.log({
      agent_name: AGENT,
      action: "run_start",
      input_summary: capped(`task=reconcile_approve review_run_id=${reviewRunId} issue_id=${issueId}`),
      output_summary: "no model and no loop: code finds the issue in the current reconciliation rows and applies its fix",
      status: "ok",
    });
    if (!canApply()) {
      tracer.log({
        agent_name: AGENT,
        action: "approval_refused",
        input_summary: capped(`issue_id=${issueId} review_run_id=${reviewRunId}`),
        output_summary: "nothing written: the data dir is the repo's own data/",
        status: "needs_human",
        why: "fixes are applied only in Docker (NODE_ENV production) or with TRADEFLOW_DATA_DIR set to a copy of data/",
      });
      return { kind: "approval", status: "needs_human", summary: `${APPROVE_REFUSED} Nothing was written.`, applied: null };
    }

    const state = new RunState({ runId, tracer, config, sampleMode, signal, localReason: "reconcile_approve reads the files as they are now, never Zetaris" });
    run = state;
    const current = await state.query("reconciliation", {}, { caller: AGENT, task: APPROVE });
    const row: Row | undefined = current.rows.find((candidate) => String(candidate.issue_id) === issueId);
    if (row === undefined) {
      tracer.log({ agent_name: AGENT, action: "approval_refused", input_summary: capped(`issue_id=${issueId}`), output_summary: capped(`not an open difference now; open: ${current.rows.map((r) => String(r.issue_id)).join(", ") || "none"}`), status: "error", why: "the issue is not in the current reconciliation rows" });
      return fail(`Issue ${issueId} is not an open difference in the current data (already applied, or unknown); nothing was written.`);
    }
    const [transactions, contributions] = await Promise.all([loadTransactions(), loadContributions()]);
    const edit = editFor(row, { transactionIds: transactions.map((t) => t.id), contributionIds: contributions.map((c) => c.id) });
    if (edit.op === "manual_check") {
      tracer.log({ agent_name: AGENT, action: "approval", input_summary: capped(`issue_id=${issueId} kind=${String(row.kind)} review_run_id=${reviewRunId}`), output_summary: capped(`nothing written: ${edit.reason}`), status: "needs_human", why: "a commission difference, a ledger trade with no broker row or a contribution with no bank deposit is checked by the owner, not applied" });
      return { kind: "approval", status: "needs_human", summary: `Issue ${issueId} is a ${edit.reason}. Code applies no fix for it; check it against your own records. Nothing was written.`, applied: null };
    }

    // The last point to stop: after this line the ledger changes.
    if (signal.aborted) return cancelledOutcome(null, 0, `task=reconcile_approve issue_id=${issueId}, before the fix was applied`);
    const writeStarted = Date.now();
    if (edit.op === "add_contribution") await appendContribution(edit.row);
    else await appendTransaction(edit.row);
    const fix = proposedFix(row);
    const what = edit.op === "add_contribution" ? `contribution ${edit.row.id}` : `transaction ${edit.row.id}`;
    tracer.log({
      agent_name: AGENT,
      action: "approval",
      input_summary: capped(`issue_id=${issueId} kind=${String(row.kind)} review_run_id=${reviewRunId}`),
      output_summary: capped(`applied: ${fix}, as ${what}`),
      status: "ok",
      why: "the owner approved it; code built the edit from the current reconciliation row, never from model text",
      duration_ms: Date.now() - writeStarted,
    });
    let memoryId: string | null = null;
    try {
      memoryId = await rememberDecision({ content: `The owner approved the reconciliation fix for ${issueId}: ${fix}, written as ${what}.`, task: "reconcile", issueId, reviewRunId, tracer });
    } catch (error) {
      if (!(error instanceof MemoryBlockedError)) throw error;
      // beforeRemember wrote its Guard line; the fix stays applied.
    }
    return { kind: "approval", status: "success", summary: `Applied the fix for ${issueId}: ${fix}, as ${what}. ${ZETARIS_STALE}`, applied: { issue_id: issueId, edit, memory_id: memoryId } };
  }

  /** World Model facts about the holdings and the trade's symbol. A failure is traced and gives an empty list. */
  function worldFor(holdings: readonly string[], tradeSymbol: string | undefined): WorldAbout[] {
    const symbols = [...new Set([...holdings, ...(tradeSymbol === undefined ? [] : [tradeSymbol])])];
    try {
      const found = worldAbout(symbols);
      tracer.log({
        agent_name: "World",
        action: "about",
        input_summary: capped(`${symbols.length} symbols: ${symbols.join(",")}`),
        output_summary: capped(`${found.length} symbols known; facts=${found.reduce((n, w) => n + w.facts.length, 0)}; announcements=${found.reduce((n, w) => n + w.announcements.length, 0)}`),
        target_agent: "Planner",
        status: "ok",
      });
      return found;
    } catch (error) {
      tracer.log({ agent_name: "World", action: "about", input_summary: `${symbols.length} symbols`, output_summary: "the World Model could not be read; the agents get no world facts", status: "error", why: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** Records an accepted run in the World Model; traced as World "record" before run_end. A failure never fails the run. */
  async function recordWorld(state: RunState, asOfDate: string, findings: readonly Finding[]): Promise<void> {
    const startedAt = Date.now();
    try {
      const written = await recordRun({ run_id: runId, as_of: asOfDate, results: state.store, findings });
      tracer.log({
        agent_name: "World",
        action: "record",
        input_summary: capped(`run ${runId} as_of ${asOfDate}: ${Object.keys(state.store).length} query results; context review_week ${asOfDate}`),
        output_summary: `entities=${written.entities}; facts=${written.facts}; relations=${written.relations}; run_query_ids=${written.run_query_ids.join(",") || "none"}`,
        status: "ok",
        why: "an accepted run is recorded from its query results, never from model text",
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      tracer.log({
        agent_name: "World",
        action: "record",
        input_summary: `run ${runId} as_of ${asOfDate}`,
        output_summary: "nothing recorded: the World Model write failed",
        status: "error",
        why: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  /** Traced once per rejected round: what the next round's Planner and Analyst get. */
  function revise(round: number, fix: string, previousFindings: number, flaggedFindings?: number): void {
    const keeps = flaggedFindings === undefined || previousFindings === 0 ? "" : `; code keeps the ${previousFindings - flaggedFindings} the fix does not flag`;
    tracer.log({
      agent_name: AGENT,
      action: "revise",
      input_summary: `round ${round + 1} of ${config.MAX_ROUNDS} rejected`,
      output_summary: capped(
        round + 1 < config.MAX_ROUNDS
          ? taskName === "pre_trade" || taskName === "reconcile"
            ? `round ${round + 2}: the plan is fixed; the Analyst gets its ${previousFindings} previous findings and the fix${keeps}`
            : taskName === "thesis_check"
            ? `round ${round + 2}: the plan is reused; the Analyst reruns only the batches that hold a journal id the fix names, with their previous findings and the fix, and the other batches keep their ${previousFindings} findings`
            : `round ${round + 2}: the Planner gets the fix as feedback and the Analyst its ${previousFindings} previous findings and the fix${keeps}`
          : `no round left; the run returns needs_human with the best draft`,
      ),
      target_agent: round + 1 < config.MAX_ROUNDS ? (taskName === "thesis_check" || taskName === "pre_trade" || taskName === "reconcile" ? "Analyst" : "Planner") : null,
      status: "retry",
      why: fix,
      retry_count: round,
    });
  }

  function reply(outcome: Outcome, usage: RunUsage): RunResult {
    const base = { run_id: runId, task: taskName, agents, usage, trace_id: runId, log_file: logFile, execution_time_seconds: seconds() };
    if (outcome.kind === "error") return { ...base, status: "error", output: null, error: outcome.error };
    if (outcome.kind === "approval") {
      const output: RunOutput = {
        summary: outcome.summary,
        review_markdown: `${outcome.summary}\n\n${DISCLAIMER}`,
        findings: [],
        gaps: [],
        citations: [],
        needs_human: outcome.status === "needs_human",
        declined_advice: false,
        injection_seen: false,
        memories_recalled: [],
        applied_corrections: [],
        rounds: 0,
        scores: null,
        model_source: "none: code applies an approved fix",
        partial: false,
        stop_reason: null,
        applied: outcome.applied,
      };
      return { ...base, status: outcome.status, output, error: null };
    }
    if (outcome.kind === "feedback") {
      const output: RunOutput = {
        summary: outcome.summary,
        // Every review ends with the disclaimer line, the feedback acknowledgement too.
        review_markdown: `${outcome.summary}\n\n${DISCLAIMER}`,
        findings: [],
        gaps: [],
        citations: [],
        needs_human: false,
        declined_advice: false,
        injection_seen: false,
        memories_recalled: [],
        applied_corrections: [],
        rounds: 0,
        scores: null,
        model_source: [...modelIds].join(", ") || (sampleMode ? "sample-model" : config.models.fast ?? "none"),
        partial: false,
        stop_reason: null,
        memory_ids_added: outcome.memory_ids_added,
      };
      return { ...base, status: "success", output, error: null };
    }

    const store = run?.store ?? {};
    const draft = outcome.draft;
    const findings = draft?.findings ?? [];
    const gaps = draft?.gaps ?? [];
    const stopReason = outcome.kind === "needs_human" ? outcome.stop : null;
    const text = outcome.kind === "success" || outcome.kind === "escalated" ? outcome : outcome.summary !== undefined && outcome.review_markdown !== undefined ? { summary: outcome.summary, review_markdown: outcome.review_markdown } : null;
    const explanation = outcome.kind === "needs_human" ? stopText(outcome.stop, config, outcome.detail) : "";
    const output: RunOutput = {
      summary: text?.summary ?? explanation,
      review_markdown: text?.review_markdown ?? draftReview(findings, gaps, explanation),
      findings,
      gaps,
      citations: citationsOf(findings, store),
      needs_human: outcome.kind === "needs_human" || outcome.kind === "escalated",
      declined_advice: flags.declined,
      injection_seen: flags.injection,
      memories_recalled: memories.map(({ id, tags }) => ({ id, tags: [...tags] })),
      applied_corrections: memories.filter((memory) => memory.tags.includes("correction")).map(({ id, content }) => ({ id, content })),
      rounds: outcome.rounds,
      scores: lastScores,
      model_source: [...modelIds].join(", ") || (sampleMode ? "sample-model" : "none"),
      partial: outcome.kind === "needs_human",
      stop_reason: stopReason,
      ...(taskName === "thesis_check" ? { verdicts: verdictsOf(findings, thesisIds) } : {}),
      ...(taskName === "pre_trade" && preTrade !== null ? { new_findings: preTrade.new_findings, escalation: preTrade.escalation } : {}),
      ...(taskName === "reconcile" && reconciliation !== null ? { proposals: proposalsFrom(reconciliation.rows, findings, reconciliation.run_query_id) } : {}),
    };
    return { ...base, status: outcome.kind === "success" ? "success" : "needs_human", output, error: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// briefing: a fixed chain of three whole runs. Code builds it from their results; no model is called here.

const BRIEFING_CHAIN = [
  { task: "explain_week", suffix: "1-explain_week", heading: "What moved", why: "what moved in the portfolio this week, against the sector indices and DSEX, answering the owner's question" },
  { task: "thesis_check", suffix: "2-thesis_check", heading: "Your theses", why: "whether each thesis in the owner's journal still holds against this week's records" },
  { task: "reconcile", suffix: "3-reconcile", heading: "Ledger and broker differences", why: "every difference between the ledger and the broker and bank files, as fixes that wait for the owner's approval" },
] as const;
const BRIEFING_QUESTION = "Why did my portfolio move this week?";
/** A child run id is "<run_id>-<suffix>" and must still fit RUN_ID_PATTERN, so the briefing's own id leaves room for the longest suffix. */
const BRIEFING_ID_ROOM = 80 - Math.max(...BRIEFING_CHAIN.map((child) => child.suffix.length + 1));

/** A section whose review is in the briefing: a success, or the reconcile run's proposals waiting for approval (needs_human, no stop reason). */
const covered = (section: BriefingSection): boolean => section.status === "success" || (section.status === "needs_human" && section.stop_reason === null);

/** The child's review without its closing disclaimer line, which the briefing writes once at the end. */
function withoutDisclaimer(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => line.trim() !== DISCLAIMER)
    .join("\n")
    .trim();
}

function sumUsage(sections: readonly BriefingSection[], durationMs: number): RunUsage {
  const usage: RunUsage = { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: durationMs };
  for (const { usage: part } of sections) {
    usage.model_calls += part.model_calls;
    usage.query_calls += part.query_calls;
    usage.tokens_in += part.tokens_in;
    usage.tokens_out += part.tokens_out;
  }
  return usage;
}

/**
 * The weekly briefing. Validates like every other task (a bad or out-of-range as_of is InvalidInput and no child run
 * starts), resolves as_of once, writes one Orchestrator "fixed_plan" line, then runs explain_week, thesis_check and
 * reconcile through `runChild` (run() unless a test replaces it), at most MAX_CONCURRENT_CHILDREN at a time (1 runs
 * them one after another). Each child keeps its own limits and trace file, gets a config whose RUN_TIMEOUT_MS is the
 * smaller of its own and the briefing's time left when it starts, and is skipped with stop_reason "run_timeout" when
 * BRIEFING_MIN_CHILD_MS is not left. At fan-in, when every child has settled, one "handoff" line per child is written
 * in task order, with the child's usage (so a run's lines other than run_end still add up to its usage) and its
 * started_at and finished_at. A child that stops or fails never removes the others. Never throws.
 */
export async function briefing(options: RunOptions, runChild: RunChild = run): Promise<RunResult> {
  const started = Date.now();
  const { runId } = options;
  const config = options.config ?? loadConfig();
  const sampleMode = options.sampleMode ?? config.sampleMode;
  const input = options.input;
  /** Set by run() (the registry's signal, combined with a caller's); undefined when briefing() is called directly. */
  const signal = options.signal;
  const seconds = () => Math.round(Date.now() - started) / 1000;
  const noUsage = (): RunUsage => ({ model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: Date.now() - started });
  const refused = (message: string): RunResult => ({ run_id: String(runId), task: BRIEFING, status: "error", output: null, error: { type: "InvalidInput", message, recoverable: false }, agents: [], usage: noUsage(), trace_id: String(runId), log_file: null, execution_time_seconds: seconds() });

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !isRunId(runId)) return refused(`Invalid run id: ${JSON.stringify(String(runId))}.`);
  if (runId.length > BRIEFING_ID_ROOM) return refused(`A briefing's run id is at most ${BRIEFING_ID_ROOM} characters, because each child's run id adds a suffix.`);

  const tracer = startRun(runId, { task: BRIEFING });
  const logFile = path.relative(process.cwd(), tracer.file);
  let asOf: string | null = null;
  const sections: BriefingSection[] = [];
  const results = new Map<string, RunResult>();
  let failure: RunError | null = null;

  try {
    failure = await chain();
  } catch (error) {
    failure = errorOf(error);
  }

  const usage = sumUsage(sections, Date.now() - started);
  // Cancelled while sections were missing: one "cancelled" line, then run_end. A cancel that landed after every section was covered changes nothing.
  const cancelled = failure === null && signal?.aborted === true && !sections.every(covered);
  if (cancelled) {
    tracer.log({
      agent_name: AGENT,
      action: "cancelled",
      input_summary: capped(`task=${BRIEFING} as_of=${asOf ?? "unresolved"}`),
      output_summary: capped(`cancelled: ${sections.filter((section) => section.stop_reason === "cancelled").map((section) => `${section.task}:${section.status}`).join(", ") || "no section"} stopped; the run returns needs_human with the sections that finished`),
      status: "needs_human",
      why: "cancelled by the owner",
      stop_reason: "cancelled",
    });
  }
  const result = build();
  tracer.log({
    agent_name: AGENT,
    action: "run_end",
    input_summary: capped(`task=${BRIEFING} as_of=${asOf ?? "unresolved"} sample_mode=${sampleMode}`),
    output_summary: capped(
      result.status === "error"
        ? `status=error type=${result.error?.type}: ${result.error?.message}`
        : `status=${result.status}${result.output?.stop_reason ? ` stop_reason=${result.output.stop_reason}` : ""} sections=${sections.map((section) => `${section.task}:${section.status}`).join(",")} citations=${result.output?.citations.length}`,
    ),
    status: result.status === "success" ? "ok" : result.status,
    ...(result.status === "error" ? { why: result.error?.message } : result.output?.stop_reason ? { why: result.output.stop_reason } : {}),
    duration_ms: usage.duration_ms,
    ...(result.output?.stop_reason ? { stop_reason: result.output.stop_reason } : {}),
    usage,
  });
  return result;

  /** Validation, as_of, the fixed plan and the three children. Returns the error that ends the briefing before any child, or null. */
  async function chain(): Promise<RunError | null> {
    const invalid = (message: string): RunError => ({ type: "InvalidInput", message, recoverable: false });
    if (input === null || typeof input !== "object") return invalid("The input must be an object.");
    if (input.question !== undefined && input.question !== null && typeof input.question !== "string") return invalid("The question must be a string.");
    if (input.as_of !== undefined && input.as_of !== null && typeof input.as_of !== "string") return invalid("as_of must be a date as YYYY-MM-DD.");
    const question = (input.question ?? "").trim() || BRIEFING_QUESTION;

    // as_of once: every child gets the resolved date.
    const data = await new RunState({ runId, tracer, config, sampleMode }).queryData();
    const resolved = resolveAsOf(data.portfolio.bars, input.as_of ?? null);
    if (!resolved.ok) return invalid(resolved.error);
    asOf = resolved.asOf;
    if (input.as_of && input.as_of !== asOf) {
      tracer.log({
        agent_name: GUARD,
        action: "as_of_moved",
        input_summary: `as_of ${input.as_of}`,
        output_summary: `as_of moved from ${input.as_of} to ${asOf}`,
        status: "ok",
        why: "as_of is not a session: the Thursday before a Friday or Saturday, or the last session on or before the date",
      });
    }

    tracer.log({
      agent_name: AGENT,
      action: "fixed_plan",
      input_summary: capped(`task=${BRIEFING} as_of=${asOf}`),
      output_summary: capped(`no Planner call: ${BRIEFING_CHAIN.map((child) => child.task).join(", ")} as three whole runs, ${BRIEFING_CHAIN.length} children, up to ${config.MAX_CONCURRENT_CHILDREN} at a time`),
      target_agent: BRIEFING_CHAIN[0].task,
      status: "ok",
      why: BRIEFING_CHAIN.map((child, index) => `${index + 1}. ${child.task}: ${child.why}.`).join(" "),
    });

    // The children start through runWithLimit, at most MAX_CONCURRENT_CHILDREN at once. A job never writes to the
    // parent trace or to `sections`: the sections and the handoff lines are written at fan-in, in task order.
    const deadline = started + config.BRIEFING_TIMEOUT_MS;
    type Outcome = { skipped: { left: number; reason: "run_timeout" | "cancelled" } | null; reply: RunResult | null; started_at: string; finished_at: string };
    const jobs = BRIEFING_CHAIN.map((child) => async (): Promise<Outcome> => {
      const childRunId = `${runId}-${child.suffix}`;
      const startedAt = new Date().toISOString();
      const left = deadline - Date.now();
      // A child that has not started when the briefing is cancelled never starts.
      if (signal?.aborted) return { skipped: { left, reason: "cancelled" }, reply: null, started_at: startedAt, finished_at: startedAt };
      if (left < BRIEFING_MIN_CHILD_MS) return { skipped: { left, reason: "run_timeout" }, reply: null, started_at: startedAt, finished_at: startedAt };
      const childInput: RunInput = child.task === "explain_week" ? { question, as_of: asOf } : { as_of: asOf };
      const childConfig: Config = { ...config, RUN_TIMEOUT_MS: Math.min(config.RUN_TIMEOUT_MS, left) };
      let reply: RunResult;
      try {
        reply = await runChild({ runId: childRunId, task: child.task, input: childInput, sampleMode, config: childConfig, parentRunId: runId, ...(signal === undefined ? {} : { signal }), ...(options.localReason === undefined ? {} : { localReason: options.localReason }) });
      } catch (error) {
        const caught = errorOf(error);
        reply = { run_id: childRunId, task: child.task, status: "error", output: null, error: caught, agents: [], usage: noUsage(), trace_id: childRunId, log_file: null, execution_time_seconds: 0 };
      }
      return { skipped: null, reply, started_at: startedAt, finished_at: new Date().toISOString() };
    });
    const settled = await runWithLimit(jobs, config.MAX_CONCURRENT_CHILDREN);

    // Fan-in: every child has settled. One section, and one handoff or child_skipped line, per child in task order.
    BRIEFING_CHAIN.forEach((child, index) => {
      const childRunId = `${runId}-${child.suffix}`;
      // A job catches its own errors, so a rejection here is unexpected; it still becomes an error section.
      const settledJob = settled[index];
      const { skipped, reply, started_at, finished_at }: Outcome =
        settledJob.status === "fulfilled"
          ? settledJob.value
          : { skipped: null, reply: { run_id: childRunId, task: child.task, status: "error", output: null, error: errorOf(settledJob.reason), agents: [], usage: noUsage(), trace_id: childRunId, log_file: null, execution_time_seconds: 0 }, started_at: new Date().toISOString(), finished_at: new Date().toISOString() };
      if (skipped !== null || reply === null) {
        const left = skipped?.left ?? 0;
        const stop = skipped?.reason ?? "run_timeout";
        sections.push({
          task: child.task,
          run_id: childRunId,
          status: "skipped",
          summary: stop === "cancelled" ? `${child.task} did not start: the briefing was cancelled by the owner.` : `${child.task} did not start: ${Math.max(0, left)} ms of BRIEFING_TIMEOUT_MS (${config.BRIEFING_TIMEOUT_MS} ms) were left.`,
          stop_reason: stop,
          usage: noUsage(),
        });
        tracer.log({
          agent_name: AGENT,
          action: "child_skipped",
          input_summary: capped(`child=${child.task} run_id=${childRunId}`),
          output_summary: capped(stop === "cancelled" ? "cancelled: the briefing was stopped before this child started; no run was started" : `run_timeout: ${Math.max(0, left)} ms left, at least ${BRIEFING_MIN_CHILD_MS} ms are needed; no run was started`),
          target_agent: child.task,
          status: "needs_human",
          why: stop === "cancelled" ? "cancelled by the owner" : "run_timeout",
          stop_reason: stop,
        });
        return;
      }
      const stopReason = reply.output?.stop_reason ?? null;
      const section: BriefingSection = {
        task: child.task,
        run_id: childRunId,
        status: reply.status,
        summary: reply.output?.summary ?? `${reply.error?.type ?? "Error"}: ${reply.error?.message ?? "the run returned nothing"}`,
        stop_reason: stopReason,
        usage: reply.usage,
      };
      sections.push(section);
      results.set(childRunId, reply);
      tracer.log({
        agent_name: AGENT,
        action: "handoff",
        input_summary: capped(`child=${child.task} run_id=${childRunId} as_of=${asOf}`),
        output_summary: capped(`status=${reply.status}${stopReason === null ? "" : ` stop_reason=${stopReason}`}: ${section.summary}`),
        target_agent: child.task,
        // An errored child leaves the briefing needs_human, and a mid-trace "error" would read as the end of the run.
        status: reply.status === "success" ? "ok" : "needs_human",
        why: child.why,
        child_run_id: childRunId,
        started_at,
        finished_at,
        duration_ms: reply.usage.duration_ms,
        usage: { model_calls: reply.usage.model_calls, query_calls: reply.usage.query_calls, tokens_in: reply.usage.tokens_in, tokens_out: reply.usage.tokens_out },
        ...(stopReason === null ? {} : { stop_reason: stopReason }),
      });
    });
    return null;
  }

  function build(): RunResult {
    const base = { run_id: runId, task: BRIEFING, agents: [], usage, trace_id: runId, log_file: logFile, execution_time_seconds: seconds() };
    if (failure !== null) return { ...base, status: "error", output: null, error: failure };

    const done = sections.every(covered);
    // A cancelled briefing says so whatever its first stopped section was.
    const stopReason = cancelled ? "cancelled" : (sections.find((section) => section.stop_reason !== null)?.stop_reason ?? null);
    const parts: string[] = [`# Weekly briefing for ${asOf}`];
    const citations: Citation[] = [];
    const findings: Finding[] = [];
    const gaps: string[] = [];
    const modelSources = new Set<string>();
    BRIEFING_CHAIN.forEach((child, index) => {
      const section = sections[index];
      parts.push(`## ${child.heading}`);
      const reply = results.get(section.run_id);
      if (covered(section) && reply?.output) {
        parts.push(withoutDisclaimer(reply.output.review_markdown));
        citations.push(...reply.output.citations.map((citation) => ({ ...citation, child_run_id: section.run_id })));
        findings.push(...reply.output.findings);
        gaps.push(...reply.output.gaps);
      } else {
        const reason = section.stop_reason ?? "error";
        parts.push(section.status === "skipped" ? `Not covered: ${section.task} stopped (${reason}); it did not start, so it has no trace.` : `Not covered: ${section.task} stopped (${reason}); its trace is ${section.run_id}.`);
        gaps.push(`${section.task} stopped (${reason}).`);
      }
      for (const source of (reply?.output?.model_source ?? "").split(", ")) if (source !== "" && !source.startsWith("none")) modelSources.add(source);
    });
    parts.push(DISCLAIMER);

    const output: RunOutput = {
      summary: `Weekly briefing for ${asOf}: ${sections.map((section) => `${section.task} ${section.status}`).join(", ")}.`,
      review_markdown: parts.join("\n\n"),
      findings,
      gaps,
      citations,
      needs_human: !done,
      declined_advice: [...results.values()].some((reply) => reply.output?.declined_advice === true),
      injection_seen: [...results.values()].some((reply) => reply.output?.injection_seen === true),
      memories_recalled: [],
      applied_corrections: [],
      rounds: 0,
      scores: null,
      model_source: [...modelSources].join(", ") || (sampleMode ? "sample-model" : "none"),
      partial: !done,
      stop_reason: done ? null : stopReason,
      sections,
    };
    return { ...base, status: done ? "success" : "needs_human", output, error: null };
  }
}
