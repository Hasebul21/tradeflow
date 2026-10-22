// What one run shares across its rounds and agents: the per-run query cache (keyed by query id and params), the
// result store (every result in full, keyed by run_query_id, which guards.checkCitations reads), the usage counters
// and the budget checks. A query already run in this run (in an earlier round, or planned twice) comes back from the
// cache with the same run_query_id, is traced as agent "Query", action "cached", and counts no query call. Every
// other call goes through queries.runQuery, and so through guards.beforeQuery. Server only (queries.ts reads data/).
import { loadConfig, type Config } from "./config";
import type { ResultStore } from "./context";
import type { CompleteResult } from "./llm";
import { QUERIES, isQueryId, loadQueryData, runQuery, type QueryData, type QueryResult } from "./queries";
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

  constructor(options: RunStateOptions) {
    this.runId = options.runId;
    this.tracer = options.tracer;
    this.config = options.config ?? loadConfig(process.env, () => {});
    this.sampleMode = options.sampleMode ?? this.config.sampleMode;
    this.data = options.data;
    this.zetaris = options.zetaris;
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

  /**
   * Runs one named query once per run. A call already made comes back from the cache with the same run_query_id,
   * traced as agent "Query", action "cached", status "ok", and counts no query call. Otherwise runQuery runs it
   * (guards.beforeQuery first) with this run's query budget, the result is stored, and the call is counted. Throws
   * what runQuery throws: QueryBlockedError when the guard refuses, QueryError when local() refuses.
   */
  async query(query_id: string, params: unknown): Promise<QueryResult> {
    const key = cacheKey(query_id, params);
    const hit = this.cache.get(key);
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
    const data = await this.queryData();
    const result = await runQuery({
      query_id,
      params,
      runId: this.runId,
      tracer: this.tracer,
      config: this.config,
      sampleMode: this.sampleMode,
      data,
      ...(this.zetaris === undefined ? {} : { zetaris: this.zetaris }),
      maxQueries: this.config.MAX_QUERY_CALLS,
      queriesUsed: this.usage.query_calls,
    });
    this.usage.query_calls += 1;
    this.cache.set(key, result);
    this.store[result.run_query_id] = result;
    return result;
  }

  tokens(): number {
    return this.usage.tokens_in + this.usage.tokens_out;
  }

  /** Throws BudgetExhaustedError when MAX_MODEL_CALLS calls or MAX_TOKENS_PER_RUN tokens are already spent. */
  beforeModelCall(): void {
    const { MAX_MODEL_CALLS, MAX_TOKENS_PER_RUN } = this.config;
    if (this.usage.model_calls >= MAX_MODEL_CALLS) {
      throw new BudgetExhaustedError("max_model_calls", `The run's model budget is spent: ${this.usage.model_calls} of ${MAX_MODEL_CALLS} calls used.`);
    }
    if (this.tokens() >= MAX_TOKENS_PER_RUN) {
      throw new BudgetExhaustedError("max_tokens", `The run's token budget is spent: ${this.tokens()} of ${MAX_TOKENS_PER_RUN} tokens used.`);
    }
  }

  /** Counts one model call and the tokens it reports. */
  afterModelCall(result: Pick<CompleteResult, "usage">): void {
    this.usage.model_calls += 1;
    if (result.usage !== null) {
      this.usage.tokens_in += result.usage.tokens_in;
      this.usage.tokens_out += result.usage.tokens_out;
    }
  }
}
