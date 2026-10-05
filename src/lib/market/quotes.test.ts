import { describe, expect, it } from "vitest";
import type { DailyBar } from "@/lib/data-types";
import { barsBySymbol, changeOverSessions, latestQuote, pctChange, rangeHighLow } from "./quotes";

function bar(date: string, close: number, symbol = "GP"): DailyBar {
  return { symbol, bar_date: date, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
}

describe("quotes", () => {
  const bars = [
    bar("2026-09-27", 100),
    bar("2026-09-28", 102),
    bar("2026-09-29", 101),
    bar("2026-09-30", 105),
    bar("2026-10-01", 104),
    bar("2026-10-04", 110),
  ];

  it("latestQuote reads the last bar and the change from the one before", () => {
    const q = latestQuote(bars);
    expect(q?.asOf).toBe("2026-10-04");
    expect(q?.ltp).toBe(110);
    expect(q?.prevClose).toBe(104);
    expect(q?.dayChangePct).toBeCloseTo(pctChange(104, 110));
    expect(latestQuote([])).toBeNull();
  });

  it("changeOverSessions compares the last close with the one n sessions earlier", () => {
    const c = changeOverSessions(bars, 5);
    expect(c?.fromDate).toBe("2026-09-27");
    expect(c?.toDate).toBe("2026-10-04");
    expect(c?.changePct).toBeCloseTo(10);
    expect(changeOverSessions(bars, 6)).toBeNull();
  });

  it("rangeHighLow spans the requested window", () => {
    expect(rangeHighLow(bars, 3)).toEqual({ high: 111, low: 103, sessions: 3 });
  });

  it("barsBySymbol groups and sorts oldest first", () => {
    const grouped = barsBySymbol([bar("2026-10-04", 2, "a"), bar("2026-10-01", 1, "A"), bar("2026-10-01", 9, "B")]);
    expect([...grouped.keys()]).toEqual(["A", "B"]);
    expect(grouped.get("A")?.map((b) => b.close)).toEqual([1, 2]);
  });
});
