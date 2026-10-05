import { describe, expect, it } from "vitest";
import type { Contribution } from "@/lib/data-types";
import type { BankDepositRow, BrokerStatementRow } from "@/lib/sources";
import { trade } from "@/test/fixture";
import { reconcile, reconcileDeposits, reconcileTrades } from "./reconcile";

function broker(ref: string, trade_date: string, symbol: string, quantity: number, price: number, commission: number): BrokerStatementRow {
  return { broker_ref: ref, trade_date, symbol, side: "buy", quantity, price, commission_bdt: commission, settlement_date: trade_date };
}

const withFee = (t: ReturnType<typeof trade>, fee: number) => ({ ...t, fees_bdt: fee });

describe("reconcile trades", () => {
  const ledger = [
    withFee(trade("t-1", "2026-09-01", "GP", "buy", 100, 300), 120),
    withFee(trade("t-2", "2026-09-02", "EBL", "buy", 300, 27.2), 32.64),
    withFee(trade("t-3", "2026-09-03", "LHBL", "buy", 100, 45), 18),
  ];

  it("matches on day, symbol, side and quantity with a price tolerance, and names the field that differs", () => {
    const r = reconcileTrades(
      [
        broker("B1", "2026-09-01", "gp", 100, 300.05, 120),
        broker("B2", "2026-09-02", "EBL", 300, 27.2, 33.84),
        broker("B3", "2026-09-04", "OLYMPIC", 20, 180, 14.4),
      ],
      ledger,
    );
    expect(r.matched).toHaveLength(0);
    expect(r.mismatched.map((p) => [p.broker.broker_ref, p.differences])).toEqual([
      ["B1", [{ field: "price", broker: 300.05, ledger: 300 }]],
      ["B2", [{ field: "commission_bdt", broker: 33.84, ledger: 32.64 }]],
    ]);
    expect(r.brokerOnly.map((b) => b.broker_ref)).toEqual(["B3"]);
    expect(r.ledgerOnly.map((t) => t.id)).toEqual(["t-3"]);
  });

  it("does not match a price outside the tolerance", () => {
    const r = reconcileTrades([broker("B1", "2026-09-01", "GP", 100, 300.2, 120)], ledger.slice(0, 1));
    expect(r.brokerOnly).toHaveLength(1);
    expect(r.ledgerOnly).toHaveLength(1);
  });
});

describe("reconcile deposits", () => {
  const contributions: Contribution[] = [
    { id: "c-1", created_at: "2026-09-07T05:00:00.000Z", amount_bdt: 70000, note: null },
    { id: "c-2", created_at: "2026-08-09T05:00:00.000Z", amount_bdt: 70000, note: null },
  ];
  const bank = (ref: string, value_date: string, amount_bdt: number): BankDepositRow => ({ bank_ref: ref, value_date, amount_bdt, narration: "" });

  it("matches on value date and amount", () => {
    const r = reconcileDeposits([bank("K1", "2026-09-07", 70000), bank("K2", "2026-07-27", 25000)], contributions);
    expect(r.matched.map((m) => m.contribution.id)).toEqual(["c-1"]);
    expect(r.bankOnly.map((b) => b.bank_ref)).toEqual(["K2"]);
    expect(r.contributionsOnly.map((c) => c.id)).toEqual(["c-2"]);
    expect(reconcile({ broker: [], ledger: [], bank: [bank("K2", "2026-07-27", 25000)], contributions }).issueCount).toBe(3);
  });
});
