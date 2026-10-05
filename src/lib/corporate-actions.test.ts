import { describe, expect, it } from "vitest";
import type { CorporateAction } from "@/lib/data-types";
import { aggregateHoldings, type TransactionRow } from "@/lib/portfolio";
import {
  bonusSharesFor,
  bonusTransactions,
  dividendIncomeBdt,
  dividendsFor,
  entitlement,
  sharesHeldOn,
} from "./corporate-actions";

function trade(id: string, ymd: string, side: "buy" | "sell", quantity: number, price: number, fees = 0): TransactionRow {
  return {
    id,
    created_at: new Date(`${ymd}T11:00:00+06:00`).toISOString(),
    symbol: "GP",
    side,
    quantity,
    price_per_share: price,
    category: null,
    fees_bdt: fees,
  };
}

function action(over: Partial<CorporateAction>): CorporateAction {
  return {
    id: "ca-01",
    symbol: "GP",
    kind: "cash_dividend",
    record_date: "2026-06-15",
    paid_on: "2026-07-10",
    cash_per_share_bdt: 10,
    bonus_ratio: null,
    announcement_id: null,
    ...over,
  };
}

const ledger = [
  trade("t-1", "2026-06-01", "buy", 100, 300, 120),
  trade("t-2", "2026-06-15", "buy", 50, 310, 62),
  trade("t-3", "2026-06-16", "sell", 30, 320, 38.4),
];

describe("corporate actions", () => {
  it("counts shares held at the end of the record date", () => {
    expect(sharesHeldOn(ledger, "gp", "2026-06-14")).toBe(100);
    expect(sharesHeldOn(ledger, "GP", "2026-06-15")).toBe(150);
    expect(sharesHeldOn(ledger, "GP", "2026-06-16")).toBe(120);
    expect(sharesHeldOn(ledger, "BRACBANK", "2026-06-16")).toBe(0);
  });

  it("gives cash for the shares held on the record date", () => {
    expect(entitlement(action({}), ledger)).toEqual({ sharesOnRecordDate: 150, cashBdt: 1500, bonusShares: 0 });
  });

  it("rounds bonus shares down to whole shares", () => {
    expect(bonusSharesFor(25, 0.1)).toBe(2);
    expect(bonusSharesFor(100, 0.29)).toBe(29);
    expect(bonusSharesFor(9, 0.1)).toBe(0);
    expect(bonusSharesFor(100, null)).toBe(0);
  });

  it("lowers the average cost after a bonus, without changing total cost", () => {
    const bonus = action({ kind: "stock_dividend", cash_per_share_bdt: null, bonus_ratio: 0.1 });
    const rows = bonusTransactions([bonus], ledger, "2026-07-31");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "bonus-ca-01", quantity: 15, price_per_share: 0, fees_bdt: 0, category: "bonus" });

    const before = aggregateHoldings(ledger)[0];
    const after = aggregateHoldings([...ledger, ...rows])[0];
    expect(after.shares).toBe(135);
    expect(after.totalCost).toBeCloseTo(before.totalCost, 2);
    expect(after.avgPrice).toBeCloseTo((before.avgPrice * 120) / 135, 6);
  });

  it("leaves bonus shares out until they are credited", () => {
    const bonus = action({ kind: "stock_dividend", cash_per_share_bdt: null, bonus_ratio: 0.1 });
    expect(bonusTransactions([bonus], ledger, "2026-07-09")).toEqual([]);
  });

  it("sums only the dividends paid by the as-of date", () => {
    const actions = [
      action({ id: "ca-01" }),
      action({ id: "ca-02", record_date: "2026-06-16", paid_on: "2026-08-01", cash_per_share_bdt: 2.5 }),
    ];
    const list = dividendsFor(actions, ledger, "2026-07-15");
    expect(list.map((d) => [d.actionId, d.shares, d.amountBdt, d.paid])).toEqual([
      ["ca-01", 150, 1500, true],
      ["ca-02", 120, 300, false],
    ]);
    expect(dividendIncomeBdt(list)).toBe(1500);
    expect(dividendIncomeBdt(dividendsFor(actions, ledger, "2026-08-01"))).toBe(1800);
  });
});
