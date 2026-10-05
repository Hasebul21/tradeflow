import type { DailyBar } from "@/lib/data-types";

/** The last session's numbers for one symbol, derived from its daily bars. */
export type Quote = {
  symbol: string;
  /** `YYYY-MM-DD` of the bar the quote comes from. */
  asOf: string;
  /** Last traded price: the close of the latest bar. */
  ltp: number;
  prevClose: number | null;
  dayHigh: number;
  dayLow: number;
  /** Close-to-close change on the latest session, as a percentage. */
  dayChangePct: number | null;
};

export type SessionChange = {
  fromDate: string;
  toDate: string;
  fromClose: number;
  toClose: number;
  changePct: number;
  sessions: number;
};

export function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

/** Group bars by symbol, each list sorted oldest first. */
export function barsBySymbol(bars: readonly DailyBar[]): Map<string, DailyBar[]> {
  const out = new Map<string, DailyBar[]>();
  for (const b of bars) {
    const key = b.symbol.toUpperCase();
    const list = out.get(key);
    if (list) list.push(b);
    else out.set(key, [b]);
  }
  for (const list of out.values()) list.sort((a, b) => a.bar_date.localeCompare(b.bar_date));
  return out;
}

/** `bars` must be one symbol, oldest first. Null when there is no bar. */
export function latestQuote(bars: readonly DailyBar[]): Quote | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  return {
    symbol: last.symbol,
    asOf: last.bar_date,
    ltp: last.close,
    prevClose: prev?.close ?? null,
    dayHigh: last.high,
    dayLow: last.low,
    dayChangePct: prev ? pctChange(prev.close, last.close) : null,
  };
}

/**
 * Close-to-close change over the last `sessions` trading days. Five sessions
 * is one DSE week (Sunday to Thursday). Null when the history is too short.
 */
export function changeOverSessions(bars: readonly DailyBar[], sessions = 5): SessionChange | null {
  if (sessions <= 0 || bars.length <= sessions) return null;
  const to = bars[bars.length - 1];
  const from = bars[bars.length - 1 - sessions];
  return {
    fromDate: from.bar_date,
    toDate: to.bar_date,
    fromClose: from.close,
    toClose: to.close,
    changePct: pctChange(from.close, to.close),
    sessions,
  };
}

/** Highest high and lowest low over the last `sessions` bars (default about a year). */
export function rangeHighLow(
  bars: readonly DailyBar[],
  sessions = 250,
): { high: number; low: number; sessions: number } | null {
  if (bars.length === 0) return null;
  const slice = bars.slice(-sessions);
  let high = -Infinity;
  let low = Infinity;
  for (const b of slice) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  return { high, low, sessions: slice.length };
}
