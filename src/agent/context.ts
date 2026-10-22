// What each model sees. Query rows reach a model only through forModel (at most MAX_ROWS_PER_QUERY rows, with
// row_count and truncated), memories only through memoriesForModel (at most MAX_MEMORIES, four fields each), and the
// Planner's catalogue only through catalogueFor (the task's queries). The full result stays in the run's result store,
// keyed by run_query_id, which guards.checkCitations reads: a cut row can still back a number.
//
// Who sees what: the Planner sees the task, question, as_of, trade, memories, world facts, catalogue and feedback,
// and no rows. The Analyst sees the planned queries' trimmed results and, on a retry, its previous findings and the
// feedback. The Evaluator sees the draft and only the results its findings cite; the Writer sees the accepted
// findings and the results they cite, never all rows (citedResults).
import { loadConfig } from "./config";
import type { Finding } from "./guards";
import type { RecalledMemory } from "./memory";
import { catalogue, type CatalogueEntry, type QueryId, type QueryResult, type Row } from "./queries";

export type Task = "explain_week" | "thesis_check" | "pre_trade" | "reconcile";
export const TASKS: readonly Task[] = ["explain_week", "thesis_check", "pre_trade", "reconcile"];

/** The run's result store: every query result in full, keyed by run_query_id. It is what checkCitations reads. */
export type ResultStore = Record<string, QueryResult>;

/** A query result as a model sees it: the first rows only, with the full count. */
export type ResultForModel = {
  run_query_id: string;
  query_id: QueryId;
  params: Record<string, unknown>;
  row_count: number;
  /** True when rows were cut to the limit. */
  truncated: boolean;
  rows: Row[];
};

/** A memory as a model sees it: nothing but these four fields. */
export type MemoryForModel = Pick<RecalledMemory, "id" | "tags" | "content" | "relevance">;

const PORTFOLIO = "PORTFOLIO";

const quietConfig = () => loadConfig(process.env, () => {});

const magnitude = (row: Row): number =>
  typeof row.contribution_bdt === "number" && Number.isFinite(row.contribution_bdt) ? Math.abs(row.contribution_bdt) : 0;

/** The PORTFOLIO row first, then the holdings by absolute contribution, largest first, so a cut drops the smallest moves. */
function orderWeekMoves(rows: readonly Row[]): Row[] {
  const portfolio = rows.filter((row) => row.symbol === PORTFOLIO);
  const holdings = rows
    .filter((row) => row.symbol !== PORTFOLIO)
    .sort((a, b) => magnitude(b) - magnitude(a) || String(a.symbol).localeCompare(String(b.symbol)));
  return [...portfolio, ...holdings];
}

/**
 * Trims one result for a model: at most `maxRows` rows (MAX_ROWS_PER_QUERY, 50), `row_count` as the full count and
 * `truncated` when rows were cut. For week_moves the PORTFOLIO row stays first and the holdings are ordered by
 * absolute contribution, so a cut never drops what mattered most. The result itself is never changed.
 */
export function forModel(result: QueryResult, maxRows: number = quietConfig().MAX_ROWS_PER_QUERY): ResultForModel {
  const ordered = result.query_id === "week_moves" ? orderWeekMoves(result.rows) : [...result.rows];
  const limit = Math.max(0, Math.floor(maxRows));
  return {
    run_query_id: result.run_query_id,
    query_id: result.query_id,
    params: result.params,
    row_count: result.rows.length,
    truncated: ordered.length > limit,
    rows: ordered.slice(0, limit),
  };
}

/** At most `max` memories (MAX_MEMORIES, 5), each reduced to id, tags, content and relevance, in the order recalled. */
export function memoriesForModel(recalled: readonly RecalledMemory[], max: number = quietConfig().MAX_MEMORIES): MemoryForModel[] {
  return recalled.slice(0, Math.max(0, Math.floor(max))).map(({ id, tags, content, relevance }) => ({ id, tags: [...tags], content, relevance }));
}

// The queries each task may plan, most important first, which is the order the Planner reads them in.
const CATALOGUE_BY_TASK: Record<Task, readonly QueryId[]> = {
  explain_week: ["week_moves", "sector_vs_stock", "announcements_between", "dividends_between", "fundamentals_latest", "journal_for_symbol", "rule_findings"],
  thesis_check: ["journal_for_symbol", "week_moves", "fundamentals_latest", "announcements_between", "dividends_between", "sector_vs_stock"],
  pre_trade: ["what_if", "journal_for_symbol", "rule_findings", "fundamentals_latest", "announcements_between"],
  reconcile: ["reconciliation", "journal_for_symbol"],
};

/** The registry's catalogue() filtered to the task: only these ids may appear in a plan. Throws on an unknown task. */
export function catalogueFor(task: Task): CatalogueEntry[] {
  const ids = Object.prototype.hasOwnProperty.call(CATALOGUE_BY_TASK, task) ? CATALOGUE_BY_TASK[task] : undefined;
  if (ids === undefined) throw new Error(`Unknown task ${JSON.stringify(task)}. Tasks: ${TASKS.join(", ")}.`);
  const byId = new Map(catalogue().map((entry) => [entry.id, entry]));
  return ids.map((id) => byId.get(id)).filter((entry): entry is CatalogueEntry => entry !== undefined);
}

/**
 * The results the findings cite, trimmed with forModel, each once, in the order first cited. A cite that is not in
 * the store gives nothing: checkCitations has already rejected it. This is all the Evaluator and the Writer see.
 */
export function citedResults(findings: readonly Pick<Finding, "cites">[], store: ResultStore, maxRows?: number): ResultForModel[] {
  const seen = new Set<string>();
  const out: ResultForModel[] = [];
  for (const finding of findings) {
    for (const cite of finding.cites) {
      if (seen.has(cite) || !Object.prototype.hasOwnProperty.call(store, cite)) continue;
      seen.add(cite);
      out.push(forModel(store[cite], maxRows));
    }
  }
  return out;
}
