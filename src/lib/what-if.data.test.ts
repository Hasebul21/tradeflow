import { describe, expect, it } from "vitest";
import { loadPortfolioData, resolveAsOf } from "@/lib/portfolio-view";
import { previewTrade } from "./what-if";

// Runs on the seeded data in data/, whose story puts SQURPHARMA above the 25% limit.
describe("what-if on the seeded portfolio", () => {
  it("a SQURPHARMA buy pushes it further over the 25% limit", async () => {
    delete process.env.TRADEFLOW_DATA_DIR;
    const data = await loadPortfolioData();
    const asOf = resolveAsOf(data.bars);
    if (!asOf.ok) throw new Error(asOf.error);
    const r = previewTrade(data, asOf.asOf, { symbol: "SQURPHARMA", side: "buy", quantity: 100 });
    if (!r.ok) throw new Error(r.error);
    const weight = (s: typeof r.before) => s.holdings.find((h) => h.symbol === "SQURPHARMA")?.weightPct ?? 0;
    expect(weight(r.before)).toBeGreaterThan(25);
    expect(weight(r.after)).toBeGreaterThan(weight(r.before));
    expect(r.after.findings.some((f) => f.kind === "max_position_weight" && f.symbol === "SQURPHARMA")).toBe(true);
  });

  it("rejects selling more SQURPHARMA than is held", async () => {
    const data = await loadPortfolioData();
    const asOf = resolveAsOf(data.bars);
    if (!asOf.ok) throw new Error(asOf.error);
    const r = previewTrade(data, asOf.asOf, { symbol: "SQURPHARMA", side: "sell", quantity: 100_000 });
    expect(r).toEqual({ ok: false, error: "Cannot sell 100000 SQURPHARMA; you hold 655." });
  });
});
