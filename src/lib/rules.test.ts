import { describe, expect, it } from "vitest";
import type { TradePlan } from "@/lib/data-types";
import {
  checkMaxPositionWeight,
  checkSectorTargets,
  checkTradePlans,
  evaluateRules,
  positionWeights,
  sectorWeights,
} from "./rules";

const rows = [
  { symbol: "SQURPHARMA", sector: "Pharmaceuticals", marketValue: 60 },
  { symbol: "GP", sector: "Telecommunication", marketValue: 30 },
  { symbol: "EBL", sector: "Bank", marketValue: 10 },
  { symbol: "NOPRICE", sector: "Bank", marketValue: null },
];

describe("rules", () => {
  it("positionWeights ignores unpriced rows and sums to 100", () => {
    const w = positionWeights(rows);
    expect(w.map((x) => x.symbol)).toEqual(["SQURPHARMA", "GP", "EBL"]);
    expect(w.reduce((s, x) => s + x.weightPct, 0)).toBeCloseTo(100);
    expect(sectorWeights(w).get("Bank")).toBeCloseTo(10);
  });

  it("flags positions above the limit, largest first", () => {
    const found = checkMaxPositionWeight(positionWeights(rows), 25);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ kind: "max_position_weight", symbol: "SQURPHARMA", weightPct: 60, limitPct: 25 });
    expect(found[1]).toMatchObject({ symbol: "GP", weightPct: 30 });
    expect(checkMaxPositionWeight(positionWeights(rows), 0)).toEqual([]);
  });

  it("flags sectors outside the tolerance in either direction", () => {
    const found = checkSectorTargets(
      positionWeights(rows),
      [
        { sector: "pharmaceuticals", target_percent: 30 },
        { sector: "Bank", target_percent: 12 },
        { sector: "Fuel & Power", target_percent: 10 },
      ],
      5,
    );
    expect(found.map((f) => (f.kind === "sector_target" ? [f.sector, f.deltaPct] : null))).toEqual([
      ["pharmaceuticals", 30],
      ["Fuel & Power", -10],
    ]);
  });

  it("reports a buy plan reached on a fall and a sell plan reached on a rise", () => {
    const plans: TradePlan[] = [
      { id: "1", created_at: "", symbol: "GP", side: "buy", target_price: 300, quantity_shares: null, note: null, executed: false },
      { id: "2", created_at: "", symbol: "EBL", side: "sell", target_price: 32, quantity_shares: 100, note: null, executed: false },
      { id: "3", created_at: "", symbol: "EBL", side: "sell", target_price: 32, quantity_shares: 100, note: null, executed: true },
      { id: "4", created_at: "", symbol: "LHBL", side: "buy", target_price: 50, quantity_shares: null, note: null, executed: false },
    ];
    const ltp = new Map([
      ["GP", 295],
      ["EBL", 33],
      ["LHBL", 60],
    ]);
    const found = checkTradePlans(plans, ltp);
    expect(found.map((f) => (f.kind === "trade_plan_reached" ? f.planId : null))).toEqual(["1", "2"]);
  });

  it("evaluateRules combines the three checks", () => {
    const found = evaluateRules({
      rows,
      ltpBySymbol: new Map([["GP", 100]]),
      rules: {
        max_position_weight_pct: 50,
        sector_tolerance_pct: 5,
        sector_targets: [{ sector: "Bank", target_percent: 10 }],
        trade_plans: [
          { id: "p", created_at: "", symbol: "GP", side: "sell", target_price: 90, quantity_shares: null, note: null, executed: false },
        ],
      },
    });
    expect(found.map((f) => f.kind)).toEqual(["max_position_weight", "trade_plan_reached"]);
  });
});
