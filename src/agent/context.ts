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

/** The symbol a thesis finding's subject stands for: a journal id in this run's journal rows gives its symbol, else the subject itself. */
function symbolOfSubject(subject: string, store: ResultStore): string {
  for (const result of Object.values(store)) {
    if (result.query_id !== "journal_for_symbol") continue;
    const row = result.rows.find((candidate) => candidate.id === subject);
    if (row !== undefined && typeof row.symbol === "string") return row.symbol;
  }
  return subject;
}

/**
 * thesis_check: the results the findings cite, each once per run_query_id, with only the rows that match a finding
 * that cites it: a row with a cell equal to the finding's subject (a symbol) or to the symbol of the journal id that
 * is its subject. A cited result with no matching row comes back with no rows. This is what the Evaluator and the
 * Writer see for this task, so a 30-thesis run does not send every symbol's rows with every finding.
 *
 * Each cited result keeps at most MAX_CITED_ROWS matching rows: many theses over one symbol can leave one result
 * (announcements_between, journal_for_symbol) holding every matching row, which blew past MAX_PROMPT_CHARS in a real
 * run. checkCitations reads the full rows from the run's result store, so trimming what the model sees never weakens
 * the citation checks; row_count still reports the full filtered count.
 */
export const MAX_CITED_ROWS = 8;

export function citedResultsForSubjects(findings: readonly Pick<Finding, "cites" | "subject">[], store: ResultStore, maxRows?: number): ResultForModel[] {
  const keys = new Map<string, Set<string>>();
  for (const finding of findings) {
    const wanted = new Set([finding.subject, symbolOfSubject(finding.subject, store)]);
    for (const cite of finding.cites) {
      if (!Object.prototype.hasOwnProperty.call(store, cite)) continue;
      const set = keys.get(cite) ?? new Set<string>();
      for (const key of wanted) set.add(key);
      keys.set(cite, set);
    }
  }
  return [...keys].map(([cite, wanted]) => {
    const result = store[cite];
    const filtered = result.rows.filter((row) => Object.values(row).some((cell) => typeof cell === "string" && wanted.has(cell)));
    const view = forModel({ ...result, rows: filtered.slice(0, MAX_CITED_ROWS) }, maxRows);
    return { ...view, row_count: filtered.length, truncated: filtered.length > view.rows.length };
  });
}

/**
 * The cited results with rows dropped from the widest result, last row first, until their JSON fits `maxChars`.
 * The Writer writes the whole review in one call, so a 30-thesis run can still leave its cited rows over
 * MAX_PROMPT_CHARS even after MAX_CITED_ROWS caps each result: many results, each a legal 8 rows, add up. Dropping
 * what the model sees never weakens a check (checkCitations reads the full rows from the store); `row_count` stays
 * the full filtered count and `truncated` says rows were cut.
 */
export function trimCitedResultsToSize(results: readonly ResultForModel[], maxChars: number): ResultForModel[] {
  const out = results.map((result) => ({ ...result, rows: [...result.rows] }));
  if (JSON.stringify(out).length <= maxChars) return out;
  for (;;) {
    let widest = -1;
    for (let i = 0; i < out.length; i += 1) {
      if (out[i].rows.length > 0 && (widest < 0 || out[i].rows.length > out[widest].rows.length)) widest = i;
    }
    if (widest < 0) return out;
    out[widest].rows.pop();
    out[widest].truncated = true;
    if (JSON.stringify(out).length <= maxChars) return out;
  }
}
