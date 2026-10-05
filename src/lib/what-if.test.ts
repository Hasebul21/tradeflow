import { describe, expect, it } from "vitest";
import { fixture } from "@/test/fixture";
import { previewTrade } from "./what-if";

describe("what-if", () => {
  // 5 Oct: AAA 100 x 111 = 11,100 (55.2%), BBB 50 x 180 = 9,000. Limit 60%.
  const data = fixture();

  it("pushes a position over the limit, and says it is new", () => {
    const r = previewTrade(data, "2026-10-05", { symbol: "aaa", side: "buy", quantity: 30 });
    if (!r.ok) throw new Error(r.error);
    expect(r.trade.price).toBe(111);
    expect(r.trade.commissionBdt).toBeCloseTo(13.32, 2);
    expect(r.cashBdt).toBeCloseTo(3330 + 13.32, 2);
    const before = r.before.holdings.find((h) => h.symbol === "AAA")?.weightPct ?? 0;
    const after = r.after.holdings.find((h) => h.symbol === "AAA")?.weightPct ?? 0;
    expect(after).toBeGreaterThan(60);
    expect(after).toBeGreaterThan(before);
    expect(r.newFindings.map((f) => f.kind)).toEqual(["max_position_weight"]);
  });

  it("does not change the data it was given", () => {
    previewTrade(data, "2026-10-05", { symbol: "AAA", side: "buy", quantity: 20 });
    expect(data.transactions).toHaveLength(2);
  });

  it("brings cash in on a sell, at a typed price", () => {
    const r = previewTrade(data, "2026-10-05", { symbol: "BBB", side: "sell", quantity: 50, price: 190 });
    if (!r.ok) throw new Error(r.error);
    expect(r.cashBdt).toBeCloseTo(-(9500 - 38), 2);
    expect(r.after.holdings.map((h) => h.symbol)).toEqual(["AAA"]);
  });

  it("rejects a sell above the shares held, and other bad input", () => {
    expect(previewTrade(data, "2026-10-05", { symbol: "BBB", side: "sell", quantity: 51 })).toEqual({
      ok: false,
      error: "Cannot sell 51 BBB; you hold 50.",
    });
    expect(previewTrade(data, "2026-10-05", { symbol: "AAA", side: "buy", quantity: 1.5 }).ok).toBe(false);
    expect(previewTrade(data, "2026-10-05", { symbol: "ZZZ", side: "buy", quantity: 1 })).toEqual({
      ok: false,
      error: "There is no price for ZZZ on 2026-10-05; type one in.",
    });
  });
});
