import { beforeAll, describe, expect, it } from "vitest";
import { QUERY_IDS, QueryError, catalogue, loadQueryData, runLocal, type QueryData, type Row } from "./queries";

// Runs on the seeded data in data/; data/README.md lists the planted cases checked here.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

const run = (id: string, params: unknown) => runLocal(id, params, d);
const bySymbol = (rows: Row[], symbol: string) => rows.find((r) => r.symbol === symbol);

describe("week_moves", () => {
  it("on 2026-10-01 leads with the PORTFOLIO row and labels BXPHARMA stock-specific", () => {
    const { rows } = run("week_moves", { as_of: "2026-10-01" });
    expect(rows[0].symbol).toBe("PORTFOLIO");
    expect(Math.abs((rows[0].change_pct as number) + 1.67)).toBeLessThanOrEqual(0.05);
    expect(Math.abs((rows[0].index_change_pct as number) + 0.75)).toBeLessThanOrEqual(0.05);
    expect(Math.abs((rows[0].vs_index_pts as number) + 0.92)).toBeLessThanOrEqual(0.05);
    const bx = bySymbol(rows, "BXPHARMA")!;
    expect(Math.abs((bx.change_pct as number) + 14.9)).toBeLessThanOrEqual(0.1);
    expect(bx.comparison).toBe("stock-specific");
  });

  it("labels only BXPHARMA and SQURPHARMA stock-specific on 2026-10-01", () => {
    const { rows } = run("week_moves", { as_of: "2026-10-01" });
    const specific = rows.filter((r) => r.comparison === "stock-specific").map((r) => r.symbol);
    expect(specific.sort()).toEqual(["BXPHARMA", "SQURPHARMA"]);
  });

  it("gives different rows on 2026-09-24 and 2026-10-01", () => {
    const a = run("week_moves", { as_of: "2026-09-24" }).rows;
    const b = run("week_moves", { as_of: "2026-10-01" }).rows;
    expect(a).not.toEqual(b);
    expect(a[0].change_pct).not.toBe(b[0].change_pct);
  });

  it("on 2026-09-17 beats DSEX by about 1.2 points", () => {
    expect(run("week_moves", { as_of: "2026-09-17" }).rows[0].vs_index_pts as number).toBeCloseTo(1.2, 0);
  });

  it("moves a Friday back to the Thursday and echoes it, with sessions defaulting to 5", () => {
    const r = run("week_moves", { as_of: "2026-09-25" });
    expect(r.params).toEqual({ as_of: "2026-09-24", sessions: 5 });
    expect(r.rows).toEqual(run("week_moves", { as_of: "2026-09-24" }).rows);
    expect(run("week_moves", { as_of: "2026-09-26" }).params.as_of).toBe("2026-09-24");
  });
});

describe("result shape", () => {
  it("returns query_id, a uuid run_query_id, params, rows and source", () => {
    const r = run("rule_findings", { as_of: "2026-10-01" });
    expect(r.query_id).toBe("rule_findings");
    expect(r.run_query_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r.source).toBe("local");
    expect(run("rule_findings", { as_of: "2026-10-01" }).run_query_id).not.toBe(r.run_query_id);
  });
});

describe("sector_vs_stock", () => {
  it("gives one row per sector with the index move against DSEX and the holdings' contribution", () => {
    const { rows } = run("sector_vs_stock", { as_of: "2026-10-01" });
    expect(rows).toHaveLength(7);
    const pharma = rows.find((r) => r.sector === "Pharmaceuticals & Chemicals")!;
    expect(pharma.change_pct as number).toBeCloseTo(-3.0, 0);
    expect(pharma.contribution_bdt as number).toBeLessThan(0);
    expect(pharma.vs_index_pts as number).toBeCloseTo((pharma.change_pct as number) - (pharma.index_change_pct as number), 1);
  });
});

describe("announcements_between", () => {
  it("returns the full records newest first", () => {
    const { rows } = run("announcements_between", { from: "2026-09-24", to: "2026-09-27", symbol: "bxpharma" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.symbol === "BXPHARMA")).toBe(true);
    const dates = rows.map((r) => r.published_at as string);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(rows[0]).toMatchObject({ category: expect.any(String), price_sensitive: expect.any(Boolean), title: expect.any(String), body: expect.any(String) });
  });

  it("returns rows: [] and no error when no announcement falls in the range", () => {
    const r = run("announcements_between", { from: "2026-01-01", to: "2026-01-02" });
    expect(r.rows).toEqual([]);
    expect(r.source).toBe("local");
  });
});

describe("fundamentals_latest", () => {
  it("gives BXPHARMA's three quarters with EPS 2.30, 2.05 and 1.62 and the change on the latest", () => {
    const { rows } = run("fundamentals_latest", { symbol: "BXPHARMA", as_of: "2026-10-01" });
    expect(rows.map((r) => r.eps_bdt)).toEqual([2.3, 2.05, 1.62]);
    expect(rows[2]).toMatchObject({ is_latest: true });
    expect(rows[2].eps_change_pct as number).toBeCloseTo(-20.98, 1);
    expect(rows[2].trailing_pe).not.toBeNull();
    expect(rows[0].eps_change_pct).toBeNull();
  });

  it("hides a quarter reported after as_of", () => {
    const { rows } = run("fundamentals_latest", { symbol: "BXPHARMA", as_of: "2026-09-24" });
    expect(rows.map((r) => r.eps_bdt)).toEqual([2.3, 2.05]);
  });

  it("rejects an unknown symbol", () => {
    expect(() => run("fundamentals_latest", { symbol: "NOSUCH", as_of: "2026-10-01" })).toThrow(QueryError);
  });
});

describe("dividends_between", () => {
  it("shows GP's 240 shares, Tk 3,000, not paid yet", () => {
    const { rows } = run("dividends_between", { from: "2026-09-20", to: "2026-09-24" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "GP", shares: 240, amount_bdt: 3000, paid: false, kind: "cash_dividend", action_id: "ca-07" });
  });

  it("lists the BRACBANK bonus issue with its 120 bonus shares", () => {
    const { rows } = run("dividends_between", { from: "2026-04-01", to: "2026-05-31" });
    expect(rows.find((r) => r.kind === "stock_dividend")).toMatchObject({ symbol: "BRACBANK", bonus_shares: 120, paid: true, amount_bdt: 0 });
  });
});

describe("journal_for_symbol", () => {
  it("leaves out an entry for a trade made after as_of", () => {
    const all = run("journal_for_symbol", { as_of: "2026-04-10" }).rows;
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((r) => r.id)).not.toContain("j-014");
    expect(run("journal_for_symbol", { as_of: "2026-10-01" }).rows.map((r) => r.id)).toContain("j-014");
  });

  it("filters to one symbol and carries thesis, horizon and exit condition", () => {
    const { rows } = run("journal_for_symbol", { symbol: "bxpharma", as_of: "2026-10-01" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.symbol === "BXPHARMA")).toBe(true);
    expect(rows.find((r) => r.transaction_id === "t-015")).toMatchObject({ thesis: expect.stringContaining("earnings growth"), horizon: expect.any(String) });
  });
});

describe("rule_findings", () => {
  it("on 2026-10-01 reports SQURPHARMA above the 25% limit and pharma above its sector target", () => {
    const { rows } = run("rule_findings", { as_of: "2026-10-01" });
    expect(rows.find((r) => r.row_type === "finding" && r.kind === "max_position_weight")).toMatchObject({ subject: "SQURPHARMA" });
    const pharma = rows.find((r) => r.row_type === "sector" && r.sector === "Pharmaceuticals & Chemicals")!;
    expect(pharma.weight_pct as number).toBeCloseTo(37.8, 0);
    expect(pharma.target_pct).toBe(30);
    expect(rows.filter((r) => r.row_type === "position").length).toBeGreaterThan(0);
  });
});

describe("what_if", () => {
  const kinds = (rows: Row[]) => rows.filter((r) => r.row_type === "new_finding").map((r) => r.kind);

  it("p-02 (buy 70 WALTONHIL) causes exactly one new finding: sector_target", () => {
    const { rows } = run("what_if", { symbol: "WALTONHIL", side: "buy", quantity: 70, price: 1179.6, as_of: "2026-10-01" });
    expect(kinds(rows)).toEqual(["sector_target"]);
    expect(rows.find((r) => r.row_type === "new_finding")).toMatchObject({ subject: "Engineering" });
    expect(rows[0]).toMatchObject({ row_type: "trade", symbol: "WALTONHIL", side: "buy", quantity: 70 });
  });

  it("p-03 (buy 300 EBL) causes no new finding", () => {
    const plan = d.portfolio.rules.trade_plans.find((p) => p.id === "p-03")!;
    const { rows } = run("what_if", { symbol: plan.symbol, side: plan.side, quantity: 300, price: plan.target_price, as_of: "2026-10-01" });
    expect(kinds(rows)).toEqual([]);
  });

  it("uses the close on as_of when no price is given, and saves nothing", () => {
    const before = JSON.stringify(d.portfolio.transactions);
    const { rows } = run("what_if", { symbol: "EBL", side: "buy", quantity: 10, as_of: "2026-10-01" });
    expect(rows[0].price as number).toBeGreaterThan(0);
    expect(JSON.stringify(d.portfolio.transactions)).toBe(before);
  });

  it("errors when no close exists, and when selling more than is held", () => {
    expect(() => run("what_if", { symbol: "NOSUCH", side: "buy", quantity: 1, as_of: "2026-10-01" })).toThrow(/no price/);
    expect(() => run("what_if", { symbol: "SQURPHARMA", side: "sell", quantity: 100000, as_of: "2026-10-01" })).toThrow(/Cannot sell/);
  });
});

describe("reconciliation", () => {
  it("gives the four planted issues with stable issue_ids", () => {
    const { rows } = run("reconciliation", {});
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.issue_id).sort()).toEqual(["BNK-0008", "BRK-20260802-035", "t-021", "t-030"].sort());
    expect(rows.find((r) => r.issue_id === "t-021")).toMatchObject({ kind: "mismatched_trade", field: "commission_bdt", broker_value: 45.68, ledger_value: 44.48, difference_bdt: 1.2, ref: "BRK-20260512-021" });
    expect(rows.find((r) => r.issue_id === "t-030")).toMatchObject({ kind: "ledger_only_trade", symbol: "LHBL" });
    expect(rows.find((r) => r.issue_id === "BRK-20260802-035")).toMatchObject({ kind: "broker_only_trade", symbol: "OLYMPIC" });
    expect(rows.find((r) => r.issue_id === "BNK-0008")).toMatchObject({ kind: "bank_only_deposit", amount_bdt: 25000 });
  });
});

describe("params and the catalogue", () => {
  it("lists all nine queries with a description and a JSON schema", () => {
    const c = catalogue();
    expect(c.map((e) => e.id)).toEqual(QUERY_IDS);
    expect(c).toHaveLength(9);
    for (const e of c) {
      expect(e.description.length).toBeGreaterThan(40);
      expect(e.params).toMatchObject({ type: "object" });
      expect(e.params).not.toHaveProperty("$schema");
    }
    const week = c.find((e) => e.id === "week_moves")!;
    expect(Object.keys(week.params.properties as object)).toEqual(["as_of", "sessions"]);
    expect(week.params.required).toEqual(["as_of"]);
    expect(Object.keys(c.find((e) => e.id === "announcements_between")!.params.properties as object)).toEqual(["from", "to", "symbol"]);
    expect(c.find((e) => e.id === "reconciliation")!.params.properties).toEqual({});
  });

  it("rejects a bad date, a date outside the data and an unknown query with a QueryError", () => {
    expect(() => run("week_moves", { as_of: "01/10/2026" })).toThrow(/yyyy-mm-dd/);
    expect(() => run("week_moves", { as_of: "2026-02-30" })).toThrow(QueryError);
    expect(() => run("week_moves", { as_of: "2026-10-08" })).toThrow(/after the data/);
    expect(() => run("week_moves", { as_of: "2025-12-31" })).toThrow(/before the data/);
    expect(() => run("announcements_between", { from: "2026-09-02", to: "2026-09-01" })).toThrow(/from must not be after to/);
    expect(() => run("nope", {})).toThrow(/Unknown query/);
  });
});
