import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { QueryBlockedError, loadQueryData, type QueryData } from "./queries";
import { BudgetExhaustedError, RunState, cacheKey } from "./run-state";
import type { TraceInput, Tracer } from "./trace";

// The seed data in data/ and a fake tracer; no trace file and no network.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

const AS_OF = "2026-10-01";

function state(env: Record<string, string> = {}) {
  const lines: TraceInput[] = [];
  const tracer = { log: (line: TraceInput) => (lines.push(line), line as never) } as unknown as Tracer;
  const run = new RunState({ runId: "t", tracer, config: loadConfig({ SAMPLE_MODE: "true", ...env }, () => {}), sampleMode: true, data: d });
  return { lines, run };
}

describe("cacheKey", () => {
  it("reads the params as the query's schema does, so defaults and key order do not make a new call", () => {
    expect(cacheKey("week_moves", { as_of: AS_OF })).toBe(cacheKey("week_moves", { sessions: 5, as_of: AS_OF }));
    expect(cacheKey("week_moves", { as_of: AS_OF })).not.toBe(cacheKey("week_moves", { as_of: AS_OF, sessions: 10 }));
    expect(cacheKey("week_moves", { as_of: AS_OF })).not.toBe(cacheKey("sector_vs_stock", { as_of: AS_OF }));
    // Unknown ids and params that fail the schema key on the raw params.
    expect(cacheKey("no_such_query", { b: 1, a: 2 })).toBe(cacheKey("no_such_query", { a: 2, b: 1 }));
  });
});

describe("RunState.query", () => {
  it("runs a query once, stores it by run_query_id, and answers the same call from the cache with no second query call", async () => {
    const { lines, run } = state();
    const first = await run.query("week_moves", { as_of: AS_OF });
    const again = await run.query("week_moves", { as_of: AS_OF, sessions: 5 });
    expect(again).toBe(first);
    expect(run.usage.query_calls).toBe(1);
    expect(run.store).toEqual({ [first.run_query_id]: first });
    const query = lines.filter((line) => line.agent_name === "Query");
    expect(query.map((line) => line.action)).toEqual(["query", "cached"]);
    expect(query[1]).toMatchObject({ status: "ok", source: "local" });
    expect(query[1].output_summary).toContain(first.run_query_id);
  });

  it("passes the run's query count to the guard, so the call after MAX_QUERY_CALLS is a QueryBlockedError and is not cached", async () => {
    const { run } = state({ MAX_QUERY_CALLS: "1" });
    await run.query("week_moves", { as_of: AS_OF });
    const error = await run.query("rule_findings", { as_of: AS_OF }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryBlockedError);
    expect((error as QueryBlockedError).reason).toMatch(/budget is spent: 1 of 1/);
    expect(run.isCached("rule_findings", { as_of: AS_OF })).toBe(false);
    expect(run.usage.query_calls).toBe(1);
  });
});

describe("the model budget", () => {
  it("counts calls and tokens, and refuses the call after MAX_MODEL_CALLS or MAX_TOKENS_PER_RUN", () => {
    const { run } = state({ MAX_MODEL_CALLS: "2", MAX_TOKENS_PER_RUN: "100" });
    run.beforeModelCall();
    run.afterModelCall({ usage: { tokens_in: 30, tokens_out: 10 } });
    run.afterModelCall({ usage: null });
    expect(run.usage).toMatchObject({ model_calls: 2, tokens_in: 30, tokens_out: 10 });
    expect(() => run.beforeModelCall()).toThrow(BudgetExhaustedError);
    expect(() => run.beforeModelCall()).toThrow(/2 of 2 calls/);

    const tokens = state({ MAX_MODEL_CALLS: "10", MAX_TOKENS_PER_RUN: "100" }).run;
    tokens.afterModelCall({ usage: { tokens_in: 90, tokens_out: 10 } });
    let caught: unknown;
    try {
      tokens.beforeModelCall();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    expect((caught as BudgetExhaustedError).stop_reason).toBe("max_tokens");
  });
});
