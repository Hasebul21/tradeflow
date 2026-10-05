import type { DailyBar, IndexBar } from "@/lib/data-types";
import { changeOverSessions, type SessionChange } from "@/lib/market/quotes";

/** Index closes as one-price bars, so the quote helpers work on them unchanged. */
function asDailyBars(bars: readonly IndexBar[]): DailyBar[] {
  return [...bars]
    .sort((a, b) => a.bar_date.localeCompare(b.bar_date))
    .map((b) => ({ symbol: b.index, bar_date: b.bar_date, open: b.close, high: b.close, low: b.close, close: b.close, volume: 0 }));
}

/** Bars of one index, oldest first. */
export function indexSeries(bars: readonly IndexBar[], index = "DSEX"): IndexBar[] {
  return bars.filter((b) => b.index === index).sort((a, b) => a.bar_date.localeCompare(b.bar_date));
}

/** Close-to-close change of the index over the last `sessions` bars. Null when the history is too short. */
export function indexChangeOverSessions(bars: readonly IndexBar[], sessions = 5): SessionChange | null {
  return changeOverSessions(asDailyBars(bars), sessions);
}

/** The index as of `asOf`: bars after that date are ignored. */
export function indexUpTo(bars: readonly IndexBar[], asOf: string | null): IndexBar[] {
  return asOf ? bars.filter((b) => b.bar_date <= asOf) : [...bars];
}
