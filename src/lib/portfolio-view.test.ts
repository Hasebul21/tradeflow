import { describe, expect, it } from "vitest";
import { fixture } from "@/test/fixture";
import { buildPortfolioView, resolveAsOf } from "./portfolio-view";

describe("portfolio view as of a date", () => {
  const data = fixture();

  it("defaults to the latest session", () => {
    expect(resolveAsOf(data.bars)).toEqual({ ok: true, asOf: "2026-10-05" });
  });

  it("resolves a Saturday to the Thursday before it", () => {
    expect(resolveAsOf(data.bars, "2026-10-03")).toEqual({ ok: true, asOf: "2026-10-01" });
  });

  it("rejects dates outside the data, and malformed ones", () => {
    const before = resolveAsOf(data.bars, "2026-09-01");
    const after = resolveAsOf(data.bars, "2026-10-10");
    expect(before.ok || before.error).toMatch(/before the data/);
    expect(after.ok || after.error).toMatch(/after the data/);
    expect(resolveAsOf(data.bars, "5 Oct").ok).toBe(false);
  });

  it("builds different views for 28 Sep and 5 Oct", () => {
    const early = buildPortfolioView(data, "2026-09-28");
    const late = buildPortfolioView(data, "2026-10-05");
    expect(early.asOf).toBe("2026-09-28");
    expect(early.holdings.map((h) => h.symbol)).toEqual(["AAA"]);
    expect(early.totalMarketValue).toBe(106 * 100);
    expect(late.holdings.map((h) => h.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(late.totalMarketValue).toBe(111 * 100 + 180 * 50);
    expect(late.market?.asOf).toBe("2026-10-05");
    expect(early.market?.asOf).toBe("2026-09-28");
  });

  it("judges the rules on the as-of prices", () => {
    expect(buildPortfolioView(data, "2026-09-28").findings.map((f) => f.kind)).toEqual(["max_position_weight"]);
    expect(buildPortfolioView(data, "2026-10-05").findings).toEqual([]);
  });
});
