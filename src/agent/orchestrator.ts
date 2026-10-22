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
import { analyse, type AnalysisOutcome } from "./agents/analyst";
import { evaluate, type Scores } from "./agents/evaluator";
import { PlanBlockedError, plan, type PlannedStep, type PlannerTrade } from "./agents/planner";
import { DISCLAIMER, write } from "./agents/writer";
import { ConfigError, loadConfig, type Config, type Tier } from "./config";
import { TASKS, type Task } from "./context";
import { injectionIn, type Finding } from "./guards";
import { ModelError, ModelHttpError, ModelTimeout, RateLimited, type AgentName } from "./llm";
import { learnCorrection, recall, seedOwnerContext, withMiner, type RecalledMemory } from "./memory";
import { branchOnWhatIf, fixedPlan, PRE_TRADE_FOCUS, resolveTrade, type PreTradeEscalation } from "./pre-trade";
import { QueryBlockedError, QueryError, type QueryId, type QueryResult, type QuerySource } from "./queries";
import { BudgetExhaustedError, RunState, type Usage } from "./run-state";
import { batchesToRerun, keepThesisSteps, prepareThesisEvidence, type PreparedTheses } from "./thesis";
import { isRunId, startRun, type Tracer } from "./trace";
import { about as worldAbout, recordRun, type WorldAbout } from "./world";
import type { Rules } from "@/lib/data-types";
import { buildPortfolioView, resolveAsOf } from "@/lib/portfolio-view";
import { readJson } from "@/lib/store";

const AGENT = "Orchestrator";
const GUARD = "Guard";
const SUMMARY_CHARS = 200;

/** The tasks this loop runs today; later steps add the others. */
const SUPPORTED: readonly Task[] = ["explain_week", "thesis_check", "pre_trade"];
/** The owner's correction to a review: stored in H-MEM by code, with no Planner and no loop. */
const FEEDBACK = "feedback";

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
  issue_id?: string;
};

/** A run id the API accepts: it becomes part of logs/trace-<run_id>.jsonl, so no dot or separator. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export type RunOptions = {
  runId: string;
  /** Default "explain_week". An unknown name is an InvalidInput error reply, never a throw. */
  task?: string;
  input: RunInput;
  /** Default config.sampleMode. */
  sampleMode?: boolean;
  /** Default loadConfig(). Passed to every agent and so to every complete() call. */
  config?: Config;
  /** Set when every query must run locally (an eval fixture data dir that is not in Postgres): the trace's reason. */
  localReason?: string;
};

export type StopReason = "rounds" | "query_calls" | "model_calls" | "tokens" | "round_timeout" | "run_timeout" | "writer_rejected";
export type RunStatus = "success" | "needs_human" | "error";

/** One cited result: what the accepted findings rest on. `rows` (at most CITATION_ROWS) is for the Explain page's drawer; it is output only and never goes into a model's input. */
export type Citation = { run_query_id: string; query_id: QueryId; params: Record<string, unknown>; source: QuerySource; row_count: number; rows: QueryResult["rows"]; /** The SQL Zetaris ran, when source is "zetaris". */ sql?: string };
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
};

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
type Draft = { findings: Finding[]; gaps: string[]; scores: Scores | null; total: number | null; round: number };

/** What the loop ends with, before the reply is built. `rounds` is the round accepted in, or the rounds run. */
type NeedsHuman = { kind: "needs_human"; stop: StopReason; detail: string; draft: Draft | null; rounds: number; summary?: string; review_markdown?: string };
type Outcome =
  | { kind: "success"; summary: string; review_markdown: string; draft: Draft; rounds: number }
  /** pre_trade: the trade would newly break a rule. A finished review for the owner to decide on, not a stopped run. */
  | { kind: "escalated"; summary: string; review_markdown: string; draft: Draft; rounds: number }
  | NeedsHuman
  /** feedback: the correction was stored; no draft, no Writer. */
  | { kind: "feedback"; summary: string; memory_ids_added: string[] }
  | { kind: "error"; error: RunError };

/**
 * Runs one task to a reply. The budgets are checked before every call, each model call gets the time left as its
 * timeout, and a budget that runs out ends the run as needs_human with the best draft (the highest total so far, or
 * the last draft when no round reached the model). The run's usage adds up every model call and every real query
 * call; the Orchestrator's run_end line, the last line of the run, repeats the total.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const { runId, input } = options;
  const taskName = options.task ?? "explain_week";
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

  const tracer = startRun(runId);
  tracer.setTask(taskName);
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

  let outcome: Outcome;
  try {
    outcome = await execute();
  } catch (error) {
    outcome = { kind: "error", error: errorOf(error) };
  }

  // An accepted run is recorded in the World Model from its query results, never from model text.
  if ((outcome.kind === "success" || outcome.kind === "escalated") && run !== undefined && asOf !== null) await recordWorld(run, asOf, outcome.draft.findings);

  const usage: RunUsage = { ...(run?.usage ?? feedbackUsage ?? { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0 }), duration_ms: Date.now() - started };
  const result = reply(outcome, usage);
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
    usage,
  });
  return result;

  // The run, start to finish. Throws only what the catch above turns into an error reply.
  async function execute(): Promise<Outcome> {
    const invalid = (message: string): Outcome => ({ kind: "error", error: { type: "InvalidInput", message, recoverable: false } });
    if (taskName === FEEDBACK) {
      if (input === null || typeof input !== "object") return invalid("The input must be an object.");
      return feedbackRun();
    }
    if (typeof taskName !== "string" || !TASKS.includes(taskName as Task)) {
      return invalid(`Unknown task ${JSON.stringify(taskName)}; the tasks are ${[...TASKS, FEEDBACK].join(", ")}.`);
    }
    const task = taskName as Task;
    if (!SUPPORTED.includes(task)) return invalid(`Task ${JSON.stringify(task)} is not supported yet; this loop runs ${[...SUPPORTED, FEEDBACK].join(", ")}.`);
    if (input === null || typeof input !== "object") return invalid("The input must be an object.");
    if (input.question !== undefined && input.question !== null && typeof input.question !== "string") return invalid("The question must be a string.");
    if (input.as_of !== undefined && input.as_of !== null && typeof input.as_of !== "string") return invalid("as_of must be a date as YYYY-MM-DD.");
    // The question is required for explain_week only; every other task gets "" when it has none.
    const question = (input.question ?? "").trim();
    if (task === "explain_week" && question === "") return invalid("The question is empty.");

    const flagRow = () => {
      flags.injection = true;
    };
    run = new RunState({ runId, tracer, config, sampleMode, ...(options.localReason === undefined ? {} : { localReason: options.localReason }), onResult: (fresh) => scrubResult(fresh, tracer, flagRow) });
    const state = run;

    // 1. as_of, once. Every input, trace line and memory tag uses the resolved date.
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

    // 2. Memory: the owner's context once, then what this question recalls, scanned in code.
    await seedOwnerContext(tracer);
    const recalled = await recall(trade === null ? question : `${question} ${trade.symbol} ${trade.side}`.trim(), asOf, tracer);
    const scrubbed = scrubMemories(recalled, tracer);
    memories = scrubbed.kept;
    if (scrubbed.flagged > 0) flags.injection = true;
    if ((await flaggedTradePlans(tracer)) > 0) flags.injection = true;
    if (asksForAdvice(question)) declineAdvice("matched in code");
    world = worldFor(buildPortfolioView(data.portfolio, asOf).holdings.map((holding) => holding.symbol), trade?.symbol);

    // 3. Time and budget.
    const runDeadline = started + config.RUN_TIMEOUT_MS;
    let roundStarted = started;
    const runLeft = () => runDeadline - Date.now();
    const roundLeft = () => roundStarted + config.ROUND_TIMEOUT_MS - Date.now();
    const timeLeft = (tier: Tier) => Math.max(0, Math.min(tier === "strong" ? config.MODEL_TIMEOUT_STRONG_MS : config.MODEL_TIMEOUT_MS, roundLeft(), runLeft()));
    const budgetStop = (needsQueries: boolean): StopReason | null => {
      if (runLeft() <= 0) return "run_timeout";
      if (roundLeft() <= 0) return "round_timeout";
      if (state.usage.model_calls >= config.MAX_MODEL_CALLS) return "model_calls";
      if (state.tokens() >= config.MAX_TOKENS_PER_RUN) return "tokens";
      if (needsQueries && state.usage.query_calls >= config.MAX_QUERY_CALLS) return "query_calls";
      return null;
    };
    const stopDetail = (reason: StopReason): string => {
      switch (reason) {
        case "model_calls":
          return `${state.usage.model_calls} of ${config.MAX_MODEL_CALLS} model calls used`;
        case "tokens":
          return `${state.tokens()} of ${config.MAX_TOKENS_PER_RUN} tokens used`;
        case "query_calls":
          return `${state.usage.query_calls} of ${config.MAX_QUERY_CALLS} query calls used`;
        case "round_timeout":
          return `${Date.now() - roundStarted} ms into the round, limit ${config.ROUND_TIMEOUT_MS} ms`;
        case "run_timeout":
          return `${Date.now() - started} ms into the run, limit ${config.RUN_TIMEOUT_MS} ms`;
        default:
          return reason;
      }
    };

    /** The highest total so far; among drafts no model scored, the latest. */
    let best: Draft | null = null;
    /** The last Analyst reply, scored or not: what a stop before the Evaluator returns. */
    let latest: Draft | null = null;
    let accepted: Draft | null = null;
    let feedback: string | null = null;
    let previous: Finding[] | null = null;
    /** thesis_check: the evidence, the plan's focus and each batch's findings and gaps, kept across rounds. */
    let thesis: { prepared: PreparedTheses; focus: string; found: (Finding[] | null)[]; gapsBy: string[][] } | null = null;
    let stop: StopReason | null = null;
    let round = 0;
    const roundsRun = () => Math.min(round + 1, config.MAX_ROUNDS);
    const stopped = (reason: StopReason, detail = stopDetail(reason)): NeedsHuman => {
      const draft = accepted ?? best ?? latest;
      tracer.log({
        agent_name: AGENT,
        action: "stop",
        input_summary: `round ${roundsRun()} of ${config.MAX_ROUNDS}`,
        output_summary: capped(`${reason}: ${detail}; the run returns needs_human with ${draft === null ? "no draft" : `the best draft (${draft.findings.length} findings, ${draft.total === null ? "score unavailable" : `total ${draft.total}`})`}`),
        status: "needs_human",
        why: reason,
        retry_count: Math.min(round, config.MAX_ROUNDS - 1),
        stop_reason: reason,
      });
      return { kind: "needs_human", stop: reason, detail, draft, rounds: roundsRun() };
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
          whatIf = await state.query(fixed[0].query_id, fixed[0].params);
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

      // 4. The loop.
      rounds: for (round = 0; round < config.MAX_ROUNDS; round += 1) {
        roundStarted = Date.now();

        let findings: Finding[];
        let gaps: string[];
        let cutByQueryBudget = false;
        if (task === "thesis_check") {
          // The plan is made once: code runs the per-symbol queries, so a later round reuses it and the evidence.
          if (thesis === null) {
            stop = budgetStop(false);
            if (stop !== null) break;
            state.beforeModelCall();
            const planned = await plan(
              { task, question, as_of: asOf, trade: null, memories, world, feedback },
              { tracer, config, sampleMode, timeoutMs: timeLeft("strong"), round },
            );
            state.afterModelCall(planned.model);
            modelIds.add(planned.model.model_id);
            if (planned.injection_seen) flags.injection = true;
            if (planned.declined_advice) declineAdvice("flagged by the Planner");
            stop = budgetStop(true);
            if (stop !== null) break;
            const prepared = await prepareThesisEvidence({ state, tracer, asOf, steps: keepThesisSteps(planned.steps, tracer, round), round });
            thesisIds = prepared.theses.map(({ journal_id, symbol }) => ({ journal_id, symbol }));
            thesis = { prepared, focus: planned.focus, found: prepared.batches.map(() => null), gapsBy: prepared.batches.map(() => []) };
            tracer.log({
              agent_name: AGENT,
              action: "evidence_built",
              input_summary: `${prepared.theses.length} theses, ${prepared.batches.length} batches of at most 15`,
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

          // The Analyst, once per batch of at most 15 theses; on a retry only the batches the fix names, the rest keep their findings.
          const rerun: Set<number> = round === 0 || feedback === null ? new Set(thesis.prepared.batches.map((_, index) => index)) : batchesToRerun(feedback, thesis.prepared.batches);
          let unusable: string | null = null;
          for (const [index, batch] of thesis.prepared.batches.entries()) {
            if (thesis.found[index] !== null && !rerun.has(index)) continue;
            stop = budgetStop(false);
            if (stop !== null) break rounds;
            const analysis = await analyse(
              { task, question, as_of: asOf, focus: thesis.focus, steps: [], theses: batch, memories, world, previous_findings: thesis.found[index], feedback: round === 0 ? null : feedback },
              { run: state, sampleMode, timeoutMs: timeLeft("main"), round },
            );
            modelIds.add(analysis.model.model_id);
            if (!analysis.ok) {
              thesis.found[index] = null;
              unusable = `The Analyst's reply for batch ${index + 1} was unusable (${analysis.error.type}): ${analysis.error.message} Reply with the JSON object the prompt defines, findings and gaps only.`;
              continue;
            }
            if (analysis.injection_seen) flags.injection = true;
            thesis.found[index] = analysis.findings;
            thesis.gapsBy[index] = analysis.gaps;
          }
          findings = thesis.found.flatMap((batchFindings) => batchFindings ?? []);
          gaps = [...new Set([...thesis.prepared.gaps, ...thesis.gapsBy.flat()])];
          if (unusable !== null) {
            feedback = unusable;
            revise(round, feedback, findings.length);
            continue;
          }
        } else if (task === "pre_trade" && trade !== null) {
          // No Planner: the plan is fixed, so a rejection goes to the Analyst with its previous findings and the fix.
          // The steps come from the cache after round 0, and the Analyst is offered no tools.
          stop = budgetStop(fixed.some((step) => !state.isCached(step.query_id, step.params)));
          if (stop !== null) break;
          const analysis: AnalysisOutcome = await analyse(
            { task, question, as_of: asOf, trade, focus: PRE_TRADE_FOCUS, steps: fixed, memories, world, previous_findings: previous, feedback, noTools: true },
            { run: state, sampleMode, timeoutMs: timeLeft("main"), round },
          );
          modelIds.add(analysis.model.model_id);
          if (!analysis.ok) {
            feedback = `The Analyst's reply was unusable (${analysis.error.type}): ${analysis.error.message} Reply with the JSON object the prompt defines, findings and gaps only.`;
            revise(round, feedback, previous?.length ?? 0);
            continue;
          }
          if (analysis.injection_seen) flags.injection = true;
          findings = analysis.findings;
          gaps = analysis.gaps;
        } else {
          // Planner. plan() has no run of its own, so its call is counted here.
          stop = budgetStop(false);
          if (stop !== null) break;
          state.beforeModelCall();
          const planned = await plan(
            { task, question, as_of: asOf, trade: input.trade ?? null, memories, world, feedback },
            { tracer, config, sampleMode, timeoutMs: timeLeft("strong"), round },
          );
          state.afterModelCall(planned.model);
          modelIds.add(planned.model.model_id);
          if (planned.injection_seen) flags.injection = true;
          if (planned.declined_advice) declineAdvice("flagged by the Planner");

          // Analyst. The query budget matters only when a planned step is not already in the cache.
          const needsQueries = planned.steps.some((step) => !state.isCached(step.query_id, step.params));
          stop = budgetStop(needsQueries);
          if (stop !== null) break;
          const analysis: AnalysisOutcome = await analyse(
            { task, question, as_of: asOf, trade: input.trade ?? null, focus: planned.focus, steps: planned.steps, memories, world, previous_findings: previous, feedback },
            { run: state, sampleMode, timeoutMs: timeLeft("main"), round },
          );
          modelIds.add(analysis.model.model_id);
          if (!analysis.ok) {
            feedback = `The Analyst's reply was unusable (${analysis.error.type}): ${analysis.error.message} Reply with the JSON object the prompt defines, findings and gaps only.`;
            revise(round, feedback, previous?.length ?? 0);
            continue;
          }
          if (analysis.injection_seen) flags.injection = true;
          findings = analysis.findings;
          gaps = analysis.gaps;
          // A planned step that the spent query budget kept from running leaves a draft on part of the evidence:
          // stop with that draft instead of scoring it as complete.
          cutByQueryBudget = state.usage.query_calls >= config.MAX_QUERY_CALLS && planned.steps.some((step) => !state.isCached(step.query_id, step.params));
        }
        latest = { findings, gaps, scores: null, total: 0, round };
        if (cutByQueryBudget) {
          stop = "query_calls";
          break;
        }

        // Evaluator: code checks first, then the fast model.
        stop = budgetStop(false);
        if (stop !== null) break;
        const verdict = await evaluate(
          { task, question, as_of: asOf, findings, gaps, memories, results: state.store },
          { tracer, run: state, config, sampleMode, timeoutMs: timeLeft("fast"), round },
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
        revise(round, feedback, previous.length);
      }
      if (stop !== null) return stopped(stop);
      if (accepted === null) return stopped("rounds", feedback ?? "no fix was recorded");

      // 5. The Writer, in the accepted round.
      stop = budgetStop(false);
      if (stop !== null) return stopped(stop);
      const written = await write(
        {
          task,
          question,
          as_of: asOf,
          findings: accepted.findings,
          results: state.store,
          gaps: accepted.gaps,
          declined_advice: flags.declined,
          escalation: preTrade?.escalation ?? null,
          memories,
          runId,
        },
        { tracer, run: state, config, sampleMode, timeoutMs: timeLeft("strong"), round: accepted.round },
      );
      modelIds.add(written.model.model_id);
      if (written.injection_seen) flags.injection = true;
      if (!written.ok) {
        const detail = written.reason ?? "the review failed its code check";
        return { ...stopped("writer_rejected", detail), summary: written.summary, review_markdown: written.review_markdown };
      }
      const done = { summary: written.summary, review_markdown: written.review_markdown, draft: accepted, rounds: accepted.round + 1 };
      return { kind: preTrade?.escalation ? "escalated" : "success", ...done };
    } catch (error) {
      // A budget an agent found spent, or a timeout that was the round's or the run's, ends as needs_human.
      if (error instanceof BudgetExhaustedError) return stopped(error.stop_reason === "max_tokens" ? "tokens" : "model_calls", error.message);
      if (error instanceof ModelTimeout) {
        if (runLeft() <= 0) return stopped("run_timeout");
        if (roundLeft() <= 0) return stopped("round_timeout");
      }
      throw error;
    }
  }

  /**
   * feedback (A5): the owner's correction goes straight to H-MEM, with no Planner and no loop. The miner's model call
   * runs inside withMiner, so its model_call line and its usage belong to this run.
   */
  async function feedbackRun(): Promise<Outcome> {
    const fail = (message: string): Outcome => ({ kind: "error", error: { type: "InvalidInput", message, recoverable: false } });
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
  function revise(round: number, fix: string, previousFindings: number): void {
    tracer.log({
      agent_name: AGENT,
      action: "revise",
      input_summary: `round ${round + 1} of ${config.MAX_ROUNDS} rejected`,
      output_summary: capped(
        round + 1 < config.MAX_ROUNDS
          ? taskName === "pre_trade"
            ? `round ${round + 2}: the plan is fixed; the Analyst gets its ${previousFindings} previous findings and the fix`
            : taskName === "thesis_check"
            ? `round ${round + 2}: the plan is reused; the Analyst reruns only the batches that hold a journal id the fix names, with their previous findings and the fix, and the other batches keep their ${previousFindings} findings`
            : `round ${round + 2}: the Planner gets the fix as feedback and the Analyst its ${previousFindings} previous findings and the fix`
          : `no round left; the run returns needs_human with the best draft`,
      ),
      target_agent: round + 1 < config.MAX_ROUNDS ? (taskName === "thesis_check" || taskName === "pre_trade" ? "Analyst" : "Planner") : null,
      status: "retry",
      why: fix,
      retry_count: round,
    });
  }

  function reply(outcome: Outcome, usage: RunUsage): RunResult {
    const base = { run_id: runId, task: taskName, agents, usage, trace_id: runId, log_file: logFile, execution_time_seconds: seconds() };
    if (outcome.kind === "error") return { ...base, status: "error", output: null, error: outcome.error };
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
    };
    return { ...base, status: outcome.kind === "success" ? "success" : "needs_human", output, error: null };
  }
}
