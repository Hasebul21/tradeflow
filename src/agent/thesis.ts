// The thesis_check task's evidence, built by code. The Planner plans journal_for_symbol (no symbol) and week_moves;
// code drops every other planned step (traced), then runs fundamentals_latest once per symbol that has a thesis, and
// announcements_between and dividends_between once each from the earliest thesis date to as_of, through the run's
// cache and runQuery (so guards.beforeQuery). Each thesis then gets one compact evidence table: EPS for every quarter
// reported by as_of (not windowed, so the quarter before the thesis is the baseline), the dividends paid or owed
// since the thesis date, and only the earnings, dividend and price-sensitive announcements since the thesis date,
// each row keeping the run_query_id of the result it came from. The Analyst gets these tables and no tools. Server
// only (the run state reads data/).
import type { PlannedStep } from "./agents/planner";
import { QueryBlockedError, QueryError, type QueryResult, type Row } from "./queries";
import type { RunState } from "./run-state";
import type { Tracer } from "./trace";

const AGENT = "Orchestrator";
const SUMMARY_CHARS = 200;
const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** At most this many theses go to the Analyst in one call. */
export const THESIS_BATCH_SIZE = 15;
/** The announcement categories the evidence keeps; a price-sensitive announcement of any category is kept too. */
const KEPT_CATEGORIES: readonly string[] = ["earnings", "dividend_declaration", "bonus_declaration"];
const JOURNAL_ID = /\bj-\d+\b/g;

export type EpsRow = { run_query_id: string; period_end: string; reported_on: string; eps_bdt: number | null };
export type DividendRow = {
  run_query_id: string;
  action_id: string;
  kind: string;
  record_date: string;
  paid_on: string;
  cash_per_share_bdt: number | null;
  amount_bdt: number | null;
  bonus_shares: number | null;
  paid: boolean;
};
export type AnnouncementRow = { run_query_id: string; id: string; published_on: string; category: string; price_sensitive: boolean; title: string };

/** One thesis with its evidence table, as the Analyst sees it. */
export type ThesisEvidence = {
  journal_id: string;
  symbol: string;
  date: string;
  thesis: string;
  exit_condition: string;
  /**
   * The run_query_id of the journal_for_symbol result that holds this thesis and its exit condition: what a finding
   * cites when it quotes the owner's words, so a figure in them ("Sell if it gains 10%") is in a cited row.
   */
  journal_run_query_id: string | null;
  /** The run_query_id of this symbol's fundamentals_latest result: what an "open" finding cites when no row settles it. */
  fundamentals_run_query_id: string | null;
  eps: EpsRow[];
  dividends: DividendRow[];
  announcements: AnnouncementRow[];
};

export type PreparedTheses = {
  theses: ThesisEvidence[];
  batches: ThesisEvidence[][];
  /** Queries that did not run, as gaps. Code writes every one of them, so the Writer may repeat their figures. */
  gaps: string[];
  /** True when a query did not run because MAX_QUERY_CALLS was spent: the evidence is partial. */
  budget_cut: boolean;
};

/** Keeps journal_for_symbol with no symbol and week_moves; every other planned step is dropped and traced. */
export function keepThesisSteps(steps: readonly PlannedStep[], tracer: Tracer, round: number): PlannedStep[] {
  const kept: PlannedStep[] = [];
  steps.forEach((step, index) => {
    const symbol = step.params.symbol;
    const keep = step.query_id === "week_moves" || (step.query_id === "journal_for_symbol" && (symbol === undefined || symbol === null));
    if (keep) {
      kept.push(step);
      return;
    }
    const reason = step.query_id === "journal_for_symbol" ? "thesis_check reads every thesis, so journal_for_symbol takes no symbol" : `code runs ${step.query_id} for this task, not the plan`;
    tracer.log({
      agent_name: AGENT,
      action: "step_dropped",
      input_summary: capped(`step ${index + 1}: ${step.query_id} ${JSON.stringify(step.params)}`),
      output_summary: capped(`dropped, never run: ${reason}`),
      status: "rejected",
      why: reason,
      retry_count: round,
    });
  });
  return kept;
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

const byDate = (a: Row, b: Row) => str(a.period_end).localeCompare(str(b.period_end));

/**
 * Runs the plan's kept steps and the per-symbol queries, then builds one evidence table per thesis (journal order,
 * newest first, as the journal result has it) and the batches of at most THESIS_BATCH_SIZE theses. A query the guard
 * or local() refuses is traced, becomes a gap and never stops the run.
 */
export async function prepareThesisEvidence(args: { state: RunState; tracer: Tracer; asOf: string; steps: readonly PlannedStep[]; round: number }): Promise<PreparedTheses> {
  const { state, tracer, asOf, round } = args;
  const gaps: string[] = [];
  let budgetCut = false;
  const attempt = async (query_id: string, params: Record<string, unknown>): Promise<QueryResult | null> => {
    if (state.queryBudgetSpentFor(query_id, params)) budgetCut = true;
    try {
      return await state.query(query_id, params, { caller: AGENT, task: "thesis_check" });
    } catch (error) {
      if (!(error instanceof QueryBlockedError) && !(error instanceof QueryError)) throw error;
      const reason = error instanceof QueryBlockedError ? error.reason : error.message;
      gaps.push(`${query_id} ${JSON.stringify(params)} did not run: ${reason}`);
      tracer.log({
        agent_name: AGENT,
        action: "step_skipped",
        input_summary: capped(`${query_id} ${JSON.stringify(params)}`),
        output_summary: capped(`not run: ${reason}`),
        status: error instanceof QueryBlockedError ? "blocked" : "error",
        why: reason,
        retry_count: round,
      });
      return null;
    }
  };

  // The plan's own steps first, in plan order; the journal always runs, as the plan says or by code when it was dropped.
  for (const step of args.steps) if (step.query_id === "week_moves") await attempt(step.query_id, step.params);
  const journal = await attempt("journal_for_symbol", { as_of: asOf });
  const entries = journal === null ? [] : journal.rows.filter((row) => str(row.id) !== "" && str(row.symbol) !== "");
  const symbols = [...new Set(entries.map((row) => str(row.symbol)))];
  const dates = entries.map((row) => str(row.trade_date)).filter((date) => date !== "");
  const earliest = dates.length === 0 ? asOf : dates.reduce((a, b) => (a < b ? a : b));

  const fundamentals = new Map<string, QueryResult>();
  for (const symbol of symbols) {
    const result = await attempt("fundamentals_latest", { symbol, as_of: asOf });
    if (result !== null) fundamentals.set(symbol, result);
  }
  const range = { from: earliest > asOf ? asOf : earliest, to: asOf };
  const announcements = symbols.length === 0 ? null : await attempt("announcements_between", range);
  const dividends = symbols.length === 0 ? null : await attempt("dividends_between", range);

  const theses = entries.map((entry): ThesisEvidence => {
    const symbol = str(entry.symbol);
    const date = str(entry.trade_date);
    const quarters = fundamentals.get(symbol);
    return {
      journal_id: str(entry.id),
      symbol,
      date,
      thesis: str(entry.thesis),
      exit_condition: str(entry.exit_condition),
      journal_run_query_id: journal?.run_query_id ?? null,
      fundamentals_run_query_id: quarters?.run_query_id ?? null,
      eps:
        quarters === undefined
          ? []
          : [...quarters.rows].sort(byDate).map((row) => ({ run_query_id: quarters.run_query_id, period_end: str(row.period_end), reported_on: str(row.reported_on), eps_bdt: num(row.eps_bdt) })),
      dividends:
        dividends === null
          ? []
          : dividends.rows
              .filter((row) => str(row.symbol) === symbol && str(row.record_date) >= date)
              .map((row) => ({
                run_query_id: dividends.run_query_id,
                action_id: str(row.action_id),
                kind: str(row.kind),
                record_date: str(row.record_date),
                paid_on: str(row.paid_on),
                cash_per_share_bdt: num(row.cash_per_share_bdt),
                amount_bdt: num(row.amount_bdt),
                bonus_shares: num(row.bonus_shares),
                paid: row.paid === true,
              })),
      announcements:
        announcements === null
          ? []
          : announcements.rows
              .filter((row) => str(row.symbol) === symbol && str(row.published_on) >= date && (KEPT_CATEGORIES.includes(str(row.category)) || row.price_sensitive === true))
              .map((row) => ({
                run_query_id: announcements.run_query_id,
                id: str(row.id),
                published_on: str(row.published_on),
                category: str(row.category),
                price_sensitive: row.price_sensitive === true,
                title: str(row.title),
              })),
    };
  });
  return { theses, batches: chunk(theses, THESIS_BATCH_SIZE), gaps, budget_cut: budgetCut };
}

/**
 * The batches a retry runs: those holding a journal id the Evaluator's fix names (for example "j-013: no EPS row
 * cited"). A fix that names no known id reruns every batch.
 */
export function batchesToRerun(fix: string | null, batches: readonly (readonly { journal_id: string }[])[]): Set<number> {
  const named = new Set(fix?.match(JOURNAL_ID) ?? []);
  const hit = new Set<number>();
  batches.forEach((batch, index) => {
    if (batch.some((thesis) => named.has(thesis.journal_id))) hit.add(index);
  });
  return hit.size > 0 ? hit : new Set(batches.map((_, index) => index));
}
