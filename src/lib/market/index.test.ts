import { describe, expect, it } from "vitest";
import type { IndexBar } from "@/lib/data-types";
import { indexChangeOverSessions, indexSeries, indexUpTo } from "./index";

const bar = (bar_date: string, close: number, index = "DSEX"): IndexBar => ({ index, bar_date, close });

describe("market index", () => {
  const bars = [
    bar("2026-10-04", 5100),
    bar("2026-09-27", 5000),
    bar("2026-09-28", 5050),
    bar("2026-09-29", 5020),
    bar("2026-09-30", 5080),
    bar("2026-10-01", 5060),
    bar("2026-10-01", 1900, "DS30"),
  ];

  it("keeps one index, oldest first", () => {
    expect(indexSeries(bars).map((b) => b.close)).toEqual([5000, 5050, 5020, 5080, 5060, 5100]);
  });

  it("measures the change over n sessions", () => {
    const c = indexChangeOverSessions(indexSeries(bars), 5);
    expect(c?.fromDate).toBe("2026-09-27");
    expect(c?.toDate).toBe("2026-10-04");
    expect(c?.changePct).toBeCloseTo(2);
    expect(indexChangeOverSessions(indexSeries(bars), 6)).toBeNull();
  });

  it("ignores bars after the as-of date", () => {
    expect(indexUpTo(indexSeries(bars), "2026-10-01").at(-1)?.close).toBe(5060);
  });
});
