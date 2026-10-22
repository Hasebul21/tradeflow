import { describe, expect, it } from "vitest";
import { differences } from "./parity-compare";
import { QUERIES, type Row } from "./queries";

const week = QUERIES.week_moves;
const base = (): Row[] => [
  { symbol: "PORTFOLIO", change_pct: -1.67 },
  { symbol: "A", from_close: 100, to_close: 90, change_pct: -10 },
  { symbol: "B", from_close: 50, to_close: 55, change_pct: 10 },
];

describe("differences", () => {
  it("is empty for the same rows, ignoring the PORTFOLIO row and columns outside the SQL", () => {
    const remote = base().filter((r) => r.symbol !== "PORTFOLIO").map((r) => ({ ...r, label: "other" }));
    expect(differences(week, base(), remote)).toEqual([]);
  });

  it("accepts a one-hundredth difference in change_pct but not in a close", () => {
    const near = base();
    near[1] = { ...near[1], change_pct: -9.99 };
    expect(differences(week, base(), near)).toEqual([]);
    const far = base();
    far[1] = { ...far[1], to_close: 90.01 };
    expect(differences(week, base(), far)).toEqual(['A.to_close: local 90, Zetaris 90.01']);
  });

  it("reports a value that differs", () => {
    const remote = base();
    remote[2] = { ...remote[2], change_pct: 12 };
    expect(differences(week, base(), remote)).toEqual(["B.change_pct: local 10, Zetaris 12"]);
  });

  it("reports a row on one side only", () => {
    const remote = base().filter((r) => r.symbol !== "B");
    remote.push({ symbol: "C", from_close: 1, to_close: 1, change_pct: 0 });
    expect(differences(week, base(), remote).sort()).toEqual(["B: in local() but not in Zetaris", "C: in Zetaris but not in local()"]);
  });

  it("reports a repeated key, which a map would hide", () => {
    const remote = [...base(), { symbol: "A", from_close: 100, to_close: 90, change_pct: -10 }];
    expect(differences(week, base(), remote)).toEqual(["A: appears more than once in Zetaris"]);
  });

  it("does not call two empty sides a match", () => {
    expect(differences(week, [{ symbol: "PORTFOLIO", change_pct: 0 }], [])).toEqual(["no rows on either side, so nothing was compared"]);
  });

  it("treats null and undefined as the same missing value", () => {
    const q = QUERIES.journal_for_symbol;
    const row = { id: "j-1", transaction_id: "t-1", symbol: "GP", side: "buy", trade_date: "2026-01-15", quantity: 1, price_per_share: 1, horizon: "weeks", thesis: "x" };
    expect(differences(q, [{ ...row }], [{ ...row, exit_condition: null }])).toEqual([]);
  });
});
