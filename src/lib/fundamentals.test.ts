import { describe, expect, it } from "vitest";
import type { Fundamental } from "@/lib/data-types";
import { quartersAsOf, summariseFundamentals, yearlyEps } from "./fundamentals";

function q(period_end: string, reported_on: string, eps: number): Fundamental {
  return {
    symbol: "BXPHARMA",
    period_end,
    reported_on,
    eps_bdt: eps,
    nav_per_share_bdt: 17,
    revenue_mn_bdt: eps * 1000,
    net_profit_mn_bdt: eps * 100,
  };
}

const rows = [q("2026-06-30", "2026-09-29", 1.6), q("2025-12-31", "2026-02-09", 2), q("2026-03-31", "2026-05-10", 2)];

describe("fundamentals", () => {
  it("only sees quarters reported by the as-of date", () => {
    expect(quartersAsOf(rows, "bxpharma", "2026-09-28").map((r) => r.period_end)).toEqual(["2025-12-31", "2026-03-31"]);
    expect(quartersAsOf(rows, "BXPHARMA", "2026-09-29")).toHaveLength(3);
    expect(quartersAsOf(rows, "GP", "2026-09-29")).toEqual([]);
  });

  it("annualises fewer than four quarters, and sums four", () => {
    expect(yearlyEps(rows.slice(0, 3))).toEqual({ eps: ((1.6 + 2 + 2) / 3) * 4, basis: "annualised" });
    const four = [...rows, q("2025-09-30", "2025-11-10", 1.4)];
    expect(yearlyEps(quartersAsOf(four, "BXPHARMA", "2026-10-05"))?.basis).toBe("trailing_4_quarters");
    expect(yearlyEps(quartersAsOf(four, "BXPHARMA", "2026-10-05"))?.eps).toBeCloseTo(7, 10);
    expect(yearlyEps([])).toBeNull();
  });

  it("gives the quarter-on-quarter change and the trailing P/E", () => {
    const s = summariseFundamentals(rows, "BXPHARMA", "2026-10-05", 131.4);
    expect(s.latest?.period_end).toBe("2026-06-30");
    expect(s.previous?.period_end).toBe("2026-03-31");
    expect(s.epsChangePct).toBeCloseTo(-20, 10);
    expect(s.peBasis).toBe("annualised");
    expect(s.trailingPe).toBeCloseTo(131.4 / 7.466666666666667, 10);
    expect(summariseFundamentals(rows, "BXPHARMA", "2026-10-05", null).trailingPe).toBeNull();
  });
});
