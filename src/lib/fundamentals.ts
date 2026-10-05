import type { Fundamental } from "@/lib/data-types";
import { pctChange } from "@/lib/market/quotes";
import { readJson } from "@/lib/store";
import { normalizeSymbol } from "@/lib/symbol";

export type PeBasis = "trailing_4_quarters" | "annualised";

export type FundamentalsSummary = {
  symbol: string;
  /** Quarters public by the as-of date, oldest first. */
  quarters: Fundamental[];
  latest: Fundamental | null;
  previous: Fundamental | null;
  /** Latest quarter against the one before, in percent. */
  epsChangePct: number | null;
  netProfitChangePct: number | null;
  revenueChangePct: number | null;
  /** Price over yearly EPS. Null without a price, or when yearly EPS is not positive. */
  trailingPe: number | null;
  /** Four quarters summed, or fewer quarters scaled up to a year. */
  peBasis: PeBasis | null;
  yearlyEpsBdt: number | null;
};

/** The quarters of `symbol` that had been reported by the end of `asOf`, oldest first. */
export function quartersAsOf(rows: readonly Fundamental[], symbol: string, asOf: string): Fundamental[] {
  const sym = normalizeSymbol(symbol);
  return rows
    .filter((r) => normalizeSymbol(r.symbol) === sym && r.reported_on <= asOf)
    .sort((a, b) => a.period_end.localeCompare(b.period_end));
}

/** Sum of the last four quarters' EPS, or the average quarter times four when fewer exist. */
export function yearlyEps(quarters: readonly Fundamental[]): { eps: number; basis: PeBasis } | null {
  if (quarters.length === 0) return null;
  const last = quarters.slice(-4);
  const sum = last.reduce((s, q) => s + q.eps_bdt, 0);
  return last.length === 4 ? { eps: sum, basis: "trailing_4_quarters" } : { eps: (sum / last.length) * 4, basis: "annualised" };
}

const change = (from: number | undefined, to: number | undefined) =>
  from === undefined || to === undefined || from === 0 ? null : pctChange(from, to);

export function summariseFundamentals(
  rows: readonly Fundamental[],
  symbol: string,
  asOf: string,
  lastClose: number | null,
): FundamentalsSummary {
  const quarters = quartersAsOf(rows, symbol, asOf);
  const latest = quarters.at(-1) ?? null;
  const previous = quarters.at(-2) ?? null;
  const yearly = yearlyEps(quarters);
  const pe = yearly && yearly.eps > 0 && lastClose !== null ? lastClose / yearly.eps : null;
  return {
    symbol: normalizeSymbol(symbol),
    quarters,
    latest,
    previous,
    epsChangePct: change(previous?.eps_bdt, latest?.eps_bdt),
    netProfitChangePct: change(previous?.net_profit_mn_bdt, latest?.net_profit_mn_bdt),
    revenueChangePct: change(previous?.revenue_mn_bdt, latest?.revenue_mn_bdt),
    trailingPe: pe,
    peBasis: yearly?.basis ?? null,
    yearlyEpsBdt: yearly?.eps ?? null,
  };
}

export async function loadFundamentals(): Promise<Fundamental[]> {
  return readJson<Fundamental[]>("fundamentals", []);
}
