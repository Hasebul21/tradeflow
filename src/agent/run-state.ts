// What one run shares across its rounds and agents: the per-run query cache (keyed by query id and params), the
// result store (every result in full, keyed by run_query_id, which guards.checkCitations reads), the usage counters
// and the budget checks. A query already run in this run (in an earlier round, or planned twice) comes back from the
// cache with the same run_query_id, is traced as agent "Query", action "cached", and counts no query call. Every
// other call goes through queries.runQuery, and so through guards.beforeQuery. Server only (queries.ts reads data/).
import { loadConfig, type Config } from "./config";
import type { ResultStore } from "./context";
import type { CompleteResult, FailedCallUsage } from "./llm";
import { checkQueryPolicy, type QueryWho } from "./guards";
import { QUERIES, QueryBlockedError, isQueryId, loadQueryData, runQuery, type QueryData, type QueryResult } from "./queries";
import type { Tracer } from "./trace";
import type { ZetarisClient } from "./zetaris";

/** What every reply carries: the calls made and the tokens spent so far in the run. */
export type Usage = { model_calls: number; query_calls: number; tokens_in: number; tokens_out: number };

export type BudgetStop = "max_model_calls" | "max_tokens";

/** A model call was asked for when no call or no token was left. The orchestrator turns it into needs_human. */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly stop_reason: BudgetStop,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export type RunStateOptions = {
  runId: string;
  tracer: Tracer;
  /** Default loadConfig(). */
  config?: Config;
  /** Default config.sampleMode. */
  sampleMode?: boolean;
  /** The loaded data; loaded once here when absent. */
  data?: QueryData;
  /** A Zetaris client to use instead of the one built from config; null forces local. */
  zetaris?: ZetarisClient | null;
  /** Set when every query must run locally; the reason each Query trace line gives. */
  localReason?: string;
  /**
   * Applied to every fresh result before it is cached and stored, so what the models and checkCitations see is the
   * same. The orchestrator uses it to remove injection wording from rows.
   */
  onResult?: (result: QueryResult) => QueryResult;
  /** The run's cancel signal. A query or a model call asked for after it aborts throws its reason; a cached result still comes back. */
  signal?: AbortSignal;
};

const SUMMARY_CHARS = 200;
const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);

/** JSON with the keys of every object sorted, so two params objects that mean the same thing read the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The cache key of one call: the query id and its params as the query's schema reads them (defaults filled, keys
 * sorted), so `{as_of}` and `{as_of, sessions: 5}` are one call. Params that fail the schema, or an unknown id, key
 * on the raw params; such a call is never cached anyway, because the guard refuses it.
 */
export function cacheKey(query_id: string, params: unknown): string {
  const id = String(query_id);
  if (isQueryId(id)) {
    const parsed = QUERIES[id].params.safeParse(params ?? {});
    if (parsed.success) return `${id} ${canonical(parsed.data)}`;
  }
  return `${id} ${canonical(params ?? {})}`;
}

export class RunState {
  readonly runId: string;
  readonly tracer: Tracer;
  readonly config: Config;
  readonly sampleMode: boolean;
  /** Every result of this run in full, keyed by run_query_id. */
  readonly store: ResultStore = {};
  readonly usage: Usage = { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0 };
  readonly started: number;
  private readonly cache = new Map<string, QueryResult>();
  private data: QueryData | undefined;
  private readonly zetaris: ZetarisClient | null | undefined;
  private readonly localReason: string | undefined;
  private readonly onResult: ((result: QueryResult) => QueryResult) | undefined;
  readonly signal: AbortSignal | undefined;

  constructor(options: RunStateOptions) {
    this.runId = options.runId;
    this.tracer = options.tracer;
    this.config = options.config ?? loadConfig(process.env, () => {});
    this.sampleMode = options.sampleMode ?? this.config.sampleMode;
    this.data = options.data;
    this.zetaris = options.zetaris;
    this.localReason = options.localReason;
    this.onResult = options.onResult;
    this.signal = options.signal;
    this.started = Date.now();
  }

  /** The loaded data, loaded once per run. */
  async queryData(): Promise<QueryData> {
    this.data ??= await loadQueryData();
    return this.data;
  }

  /** True when this call would come from the cache. */
  isCached(query_id: string, params: unknown): boolean {
    return this.cache.has(cacheKey(query_id, params));
  }

  /** True when MAX_QUERY_CALLS is spent and this query is not cached, so the run cannot answer it. */
  queryBudgetSpentFor(query_id: string, params: unknown): boolean {
    return this.usage.query_calls >= this.config.MAX_QUERY_CALLS && !this.isCached(query_id, params);
  }

  /**
   * Runs one named query once per run. A call already made comes back from the cache with the same run_query_id,
   * traced as agent "Query", action "cached", status "ok", and counts no query call. Otherwise runQuery runs it
   * (guards.beforeQuery first, with `who` when given) with this run's query budget, the result is stored, and the call is counted. Throws
   * what runQuery throws: QueryBlockedError when the guard refuses, QueryError when local() refuses.
   */
  async query(query_id: string, params: unknown, who?: QueryWho): Promise<QueryResult> {
    const key = cacheKey(query_id, params);
    const hit = this.cache.get(key);
    // The policy comes before the cache: a result another caller fetched is no way round it. An unknown id is not
    // checked here: beforeQuery names it as unknown.
    if (who !== undefined && isQueryId(query_id)) {
      const verdict = checkQueryPolicy({ query_id, params }, who, this.tracer);
      if (!verdict.ok) throw new QueryBlockedError(verdict.reason);
    }
    if (hit !== undefined) {
      this.tracer.log({
        agent_name: "Query",
        action: "cached",
        input_summary: capped(`${hit.query_id} ${JSON.stringify(hit.params)}`),
        output_summary: `${hit.rows.length} rows from the cache, run_query_id ${hit.run_query_id}; no query call counted`,
        status: "ok",
        why: "already run in this run",
        source: hit.source,
      });
      return hit;
    }
    this.signal?.throwIfAborted();
    const data = await this.queryData();
    const fresh = await runQuery({
      query_id,
      params,
      runId: this.runId,
      tracer: this.tracer,
      config: this.config,
      sampleMode: this.sampleMode,
      data,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
      ...(this.zetaris === undefined ? {} : { zetaris: this.zetaris }),
      ...(this.localReason === undefined ? {} : { localReason: this.localReason }),
      maxQueries: this.config.MAX_QUERY_CALLS,
      queriesUsed: this.usage.query_calls,
      ...(who === undefined ? {} : { who }),
    });
    this.usage.query_calls += 1;
    const result = this.onResult === undefined ? fresh : this.onResult(fresh);
    this.cache.set(key, result);
    this.store[result.run_query_id] = result;
    return result;
  }

  tokens(): number {
    return this.usage.tokens_in + this.usage.tokens_out;
  }

  /** Throws the cancel signal's reason when the run was stopped, or BudgetExhaustedError when MAX_MODEL_CALLS calls or MAX_TOKENS_PER_RUN tokens are already spent. */
  beforeModelCall(): void {
    this.signal?.throwIfAborted();
    const { MAX_MODEL_CALLS, MAX_TOKENS_PER_RUN } = this.config;
    if (this.usage.model_calls >= MAX_MODEL_CALLS) {
      throw new BudgetExhaustedError("max_model_calls", `The run's model budget is spent: ${this.usage.model_calls} of ${MAX_MODEL_CALLS} calls used.`);
    }
    if (this.tokens() >= MAX_TOKENS_PER_RUN) {
      throw new BudgetExhaustedError("max_tokens", `The run's token budget is spent: ${this.tokens()} of ${MAX_TOKENS_PER_RUN} tokens used.`);
    }
  }

  /** The model calls left before MAX_MODEL_CALLS; llm.ts sends no request past it (modelCallsLeft). */
  modelCallsLeft(): number {
    return Math.max(0, this.config.MAX_MODEL_CALLS - this.usage.model_calls);
  }

  /** Counts the call's requests (one model call each, retries included; 1 when it does not say) and its tokens. */
  afterModelCall(result: Pick<CompleteResult, "usage" | "model_calls">): void {
    this.usage.model_calls += result.model_calls ?? 1;
    if (result.usage !== null) {
      this.usage.tokens_in += result.usage.tokens_in;
      this.usage.tokens_out += result.usage.tokens_out;
    }
  }

  /** Counts what a failed call spent: every request it made (it may be billed) and the tokens they reported. */
  afterFailedModelCall(spent: FailedCallUsage): void {
    this.usage.model_calls += spent.model_calls;
    this.usage.tokens_in += spent.tokens_in;
    this.usage.tokens_out += spent.tokens_out;
  }
}
