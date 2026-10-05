import { describe, expect, it } from "vitest";
import { barsBySymbol } from "@/lib/market/quotes";
import type { SectorIndexBar } from "@/lib/data-types";
import { fixture, SESSIONS } from "@/test/fixture";
import { attribute, compareWithSector, IN_LINE_THRESHOLD_PTS } from "./attribution";

describe("attribution", () => {
  const data = fixture();
  const grouped = barsBySymbol(data.bars);
  const holdings = [
    { symbol: "AAA", sector: "Bank", shares: 100 },
    { symbol: "BBB", sector: "Cement", shares: 50 },
  ];

  it("splits the five-session move by holding and sector", () => {
    const a = attribute({ holdings, barsBySymbol: grouped, indexBars: data.indexBars });
    // AAA 106 -> 111 on 100 shares; BBB 200 -> 180 on 50 shares. Start value 10,600 + 10,000.
    expect(a.fromDate).toBe("2026-09-28");
    expect(a.toDate).toBe("2026-10-05");
    expect(a.holdings.map((h) => [h.symbol, h.contributionBdt])).toEqual([
      ["BBB", -1000],
      ["AAA", 500],
    ]);
    expect(a.changeBdt).toBe(-500);
    expect(a.startValueBdt).toBe(20600);
    expect(a.changePct).toBeCloseTo((-500 / 20600) * 100, 10);
    expect(a.sectors.map((s) => s.sector)).toEqual(["Cement", "Bank"]);
    // DSEX 5060 -> 5110.
    expect(a.indexChangePct).toBeCloseTo((50 / 5060) * 100, 10);
    expect(a.differencePts).toBeCloseTo((-500 / 20600) * 100 - (50 / 5060) * 100, 10);
  });

  it("has contributions that sum to the portfolio move", () => {
    for (const sessions of [1, 3, 5, 11]) {
      const a = attribute({ holdings, barsBySymbol: grouped, indexBars: data.indexBars, sessions });
      const bdt = a.holdings.reduce((s, h) => s + h.contributionBdt, 0);
      const pts = a.sectors.reduce((s, h) => s + h.contributionPts, 0);
      expect(bdt).toBeCloseTo(a.changeBdt, 1);
      expect(pts).toBeCloseTo(a.changePct ?? 0, 6);
    }
  });

  it("compares each holding with its sector index", () => {
    // Bank index rises 1% a session, so 5 sessions is about +5.1%; Cement is flat.
    const sectorIndexBars: SectorIndexBar[] = [
      ...SESSIONS.map((d, i) => ({ sector: "Bank", bar_date: d, close: 1000 * 1.01 ** i })),
      ...SESSIONS.map((d) => ({ sector: "Cement", bar_date: d, close: 1000 })),
    ];
    const a = attribute({ holdings, barsBySymbol: grouped, indexBars: data.indexBars, sectorIndexBars });
    const aaa = a.holdings.find((h) => h.symbol === "AAA");
    const bbb = a.holdings.find((h) => h.symbol === "BBB");
    // AAA +4.72% against Bank +5.10%: within 2 points. BBB -10% against a flat sector.
    expect(aaa?.sectorChangePct).toBeCloseTo((1.01 ** 5 - 1) * 100, 10);
    expect(aaa?.comparison).toBe("in line with sector");
    expect(bbb?.versusSectorPts).toBeCloseTo(-10, 10);
    expect(bbb?.comparison).toBe("stock-specific");
    expect(bbb?.indexChangePct).toBeCloseTo(a.indexChangePct ?? 0, 10);
  });

  it("labels by a fixed threshold, and not at all without sector data", () => {
    expect(compareWithSector(-3, -3 + IN_LINE_THRESHOLD_PTS)).toBe("in line with sector");
    expect(compareWithSector(-3.01, -3 + IN_LINE_THRESHOLD_PTS)).toBe("stock-specific");
    expect(compareWithSector(1, null)).toBeNull();
    const a = attribute({ holdings, barsBySymbol: grouped, indexBars: data.indexBars });
    expect(a.holdings.every((h) => h.comparison === null)).toBe(true);
  });

  it("leaves out holdings with too little history", () => {
    const a = attribute({ holdings, barsBySymbol: grouped, indexBars: data.indexBars, sessions: 12 });
    expect(a.unpriced).toEqual(["AAA", "BBB"]);
    expect(a.changePct).toBeNull();
    expect(a.differencePts).toBeNull();
  });
});
