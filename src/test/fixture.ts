import type { DailyBar, IndexBar } from "@/lib/data-types";
import type { TransactionRow } from "@/lib/portfolio";
import type { PortfolioData } from "@/lib/portfolio-view";

/** Sun-Thu sessions from 2026-09-20 to 2026-10-05: 12 trading days. */
export const SESSIONS = [
  "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24",
  "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01",
  "2026-10-04", "2026-10-05",
];

export function bar(symbol: string, bar_date: string, close: number): DailyBar {
  return { symbol, bar_date, open: close, high: close, low: close, close, volume: 1000 };
}

export function trade(
  id: string,
  ymd: string,
  symbol: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
): TransactionRow {
  return {
    id,
    created_at: new Date(`${ymd}T11:00:00+06:00`).toISOString(),
    symbol,
    side,
    quantity,
    price_per_share: price,
    category: null,
    fees_bdt: 0,
    account_type: "long_term",
  };
}

/**
 * A small portfolio: 100 AAA from the first session, rising 1 a day from 100;
 * 50 BBB bought on 1 Oct, flat at 200 then falling 10 a day. DSEX rises 10 a day.
 */
export function fixture(): PortfolioData {
  const bars = [
    ...SESSIONS.map((d, i) => bar("AAA", d, 100 + i)),
    ...SESSIONS.map((d, i) => bar("BBB", d, i < 10 ? 200 : 200 - 10 * (i - 9))),
  ];
  const indexBars: IndexBar[] = SESSIONS.map((d, i) => ({ index: "DSEX", bar_date: d, close: 5000 + 10 * i }));
  return {
    transactions: [trade("t-1", "2026-09-20", "AAA", "buy", 100, 100), trade("t-2", "2026-10-01", "BBB", "buy", 50, 200)],
    bars,
    instruments: new Map([
      ["AAA", { symbol: "AAA", name: "Alpha", sector: "Bank" }],
      ["BBB", { symbol: "BBB", name: "Beta", sector: "Cement" }],
    ]),
    rules: { max_position_weight_pct: 60, sector_tolerance_pct: 5, sector_targets: [], trade_plans: [] },
    contributions: [],
    actions: [],
    indexBars,
  };
}
