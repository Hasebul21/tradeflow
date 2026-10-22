import { beforeAll, describe, expect, it } from "vitest";
import { catalogueFor, citedResults, forModel, memoriesForModel, type ResultStore } from "./context";
import { checkCitations, type Finding } from "./guards";
import type { RecalledMemory } from "./memory";
import { loadQueryData, runLocal, type QueryData, type QueryResult, type Row } from "./queries";

// The seed data in data/; no trace file is written here.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

/** A made-up result of `count` rows whose change_pct is 1000 + the row's index + 0.1, so every row has its own number. */
function synthetic(runQueryId: string, count: number, queryId: QueryResult["query_id"] = "rule_findings"): QueryResult {
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({ symbol: `S${i}`, change_pct: 1000 + i + 0.1 }));
  return { query_id: queryId, run_query_id: runQueryId, params: {}, rows, source: "local", sql_head: null };
}

const finding = (claim: string, value: number, cites: string[]): Finding => ({
  kind: "move",
  subject: "S120",
  claim,
  numbers: [{ value, label: "change pct" }],
  cites,
  verdict: null,
  proposed_fix: null,
  memory_ids: [],
});

describe("forModel", () => {
  it("gives the model 50 of 200 rows with row_count 200 and truncated true, and checkCitations still finds row 120 in the store", () => {
    const big = synthetic("q-big", 200);
    const store: ResultStore = { [big.run_query_id]: big };

    const trimmed = forModel(big);
    expect(trimmed).toMatchObject({ run_query_id: "q-big", query_id: "rule_findings", row_count: 200, truncated: true });
    expect(trimmed.rows).toHaveLength(50);
    expect(trimmed.rows[0]).toEqual(big.rows[0]);
    // Row 120's number is cut from what the model sees...
    expect(trimmed.rows.some((row) => row.change_pct === 1120.1)).toBe(false);
    // ...and the store still holds all 200 rows, so a citation of it is accepted.
    expect(big.rows).toHaveLength(200);
    const result = checkCitations([finding("The data shows S120: change pct 1120.1.", 1120.1, ["q-big"])], store);
    expect(result).toEqual({ ok: true, failures: [] });
    // The same number against the trimmed rows alone would fail: the store is what makes it citable.
    const trimmedOnly: ResultStore = { "q-big": { ...big, rows: trimmed.rows } };
    expect(checkCitations([finding("The data shows S120: change pct 1120.1.", 1120.1, ["q-big"])], trimmedOnly).ok).toBe(false);
  });

  it("leaves a result under the limit whole, with truncated false", () => {
    const small = synthetic("q-small", 10);
    const trimmed = forModel(small);
    expect(trimmed).toMatchObject({ row_count: 10, truncated: false });
    expect(trimmed.rows).toEqual(small.rows);
    expect(forModel(small, 10).truncated).toBe(false);
    expect(forModel(small, 9)).toMatchObject({ row_count: 10, truncated: true });
  });

  it("puts the PORTFOLIO row of week_moves first and the holdings by absolute contribution, so a cut keeps the biggest moves", () => {
    const rows: Row[] = [
      { symbol: "AAA", contribution_bdt: -100 },
      { symbol: "BBB", contribution_bdt: 300 },
      { symbol: "PORTFOLIO", change_pct: -2.1 },
      { symbol: "CCC", contribution_bdt: -250 },
      { symbol: "DDD", contribution_bdt: null },
    ];
    const result: QueryResult = { query_id: "week_moves", run_query_id: "q-w", params: { as_of: "2026-10-01" }, rows, source: "local", sql_head: null };
    expect(forModel(result).rows.map((row) => row.symbol)).toEqual(["PORTFOLIO", "BBB", "CCC", "AAA", "DDD"]);
    const cut = forModel(result, 3);
    expect(cut.rows.map((row) => row.symbol)).toEqual(["PORTFOLIO", "BBB", "CCC"]);
    expect(cut).toMatchObject({ row_count: 5, truncated: true });
    // The result itself is untouched.
    expect(result.rows.map((row) => row.symbol)).toEqual(["AAA", "BBB", "PORTFOLIO", "CCC", "DDD"]);
  });

  it("keeps the seed's week_moves whole, PORTFOLIO first", () => {
    const moves = runLocal("week_moves", { as_of: "2026-10-01" }, d);
    const trimmed = forModel(moves);
    expect(trimmed.rows[0].symbol).toBe("PORTFOLIO");
    expect(trimmed).toMatchObject({ row_count: moves.rows.length, truncated: false });
    expect(trimmed.rows).toHaveLength(moves.rows.length);
  });
});

describe("memoriesForModel", () => {
  const recalled = (n: number): RecalledMemory[] =>
    Array.from({ length: n }, (_, i) => ({ id: `mem-${i}`, tags: ["rule"], content: `Rule ${i}.`, relevance: i === 0 ? null : 0.5, extra: "never shown" }) as RecalledMemory);

  it("keeps at most 5 memories and only id, tags, content and relevance", () => {
    const shown = memoriesForModel(recalled(7));
    expect(shown).toHaveLength(5);
    expect(shown.map((memory) => memory.id)).toEqual(["mem-0", "mem-1", "mem-2", "mem-3", "mem-4"]);
    for (const memory of shown) expect(Object.keys(memory).sort()).toEqual(["content", "id", "relevance", "tags"]);
    expect(shown[0].relevance).toBeNull();
    expect(shown[1].relevance).toBe(0.5);
    expect(memoriesForModel(recalled(7), 2)).toHaveLength(2);
    expect(memoriesForModel([])).toEqual([]);
  });
});

describe("catalogueFor", () => {
  it("gives explain_week its seven queries, in order, each with a description and a params schema", () => {
    const entries = catalogueFor("explain_week");
    expect(entries.map((entry) => entry.id)).toEqual([
      "week_moves",
      "sector_vs_stock",
      "announcements_between",
      "dividends_between",
      "fundamentals_latest",
      "journal_for_symbol",
      "rule_findings",
    ]);
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.params).toHaveProperty("type", "object");
    }
  });

  it("gives the other tasks their own catalogue", () => {
    expect(catalogueFor("thesis_check").map((entry) => entry.id)).toEqual(expect.arrayContaining(["journal_for_symbol", "week_moves"]));
    expect(catalogueFor("thesis_check").map((entry) => entry.id)).not.toContain("what_if");
    expect(catalogueFor("pre_trade")[0].id).toBe("what_if");
    expect(catalogueFor("reconcile")[0].id).toBe("reconciliation");
    expect(() => catalogueFor("briefing" as never)).toThrow(/Unknown task/);
  });
});

describe("citedResults", () => {
  it("returns only the cited results, trimmed, each once, in the order first cited", () => {
    const big = synthetic("q-1", 200);
    const small = synthetic("q-2", 3);
    const unused = synthetic("q-3", 1);
    const store: ResultStore = { "q-1": big, "q-2": small, "q-3": unused };
    const cited = citedResults([{ cites: ["q-2"] }, { cites: ["q-1", "q-2"] }, { cites: ["q-9"] }], store);
    expect(cited.map((result) => result.run_query_id)).toEqual(["q-2", "q-1"]);
    expect(cited[1]).toMatchObject({ row_count: 200, truncated: true });
    expect(cited[1].rows).toHaveLength(50);
    expect(cited[0].rows).toEqual(small.rows);
  });
});
