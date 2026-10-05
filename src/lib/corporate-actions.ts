import type { CorporateAction } from "@/lib/data-types";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { aggregateHoldings, roundBdt, type TransactionRow } from "@/lib/portfolio";
import { normalizeSymbol } from "@/lib/symbol";

/** What one holder gets from one action, fixed by the shares held on the record date. */
export type Entitlement = {
  sharesOnRecordDate: number;
  cashBdt: number;
  bonusShares: number;
};

/** One cash dividend the portfolio is entitled to. */
export type DividendView = {
  actionId: string;
  symbol: string;
  record_date: string;
  paid_on: string;
  shares: number;
  cash_per_share_bdt: number;
  amountBdt: number;
  /** True once `paid_on` is on or before the as-of date. */
  paid: boolean;
};

/** Shares of `symbol` held at the end of `ymd`, counting trades dated that Dhaka day or earlier. */
export function sharesHeldOn(rows: readonly TransactionRow[], symbol: string, ymd: string): number {
  const sym = normalizeSymbol(symbol);
  const upTo = rows.filter((r) => dhakaToday(new Date(r.created_at)) <= ymd);
  return aggregateHoldings(upTo).find((h) => h.symbol === sym)?.shares ?? 0;
}

/** Whole bonus shares only: DSE does not credit fractions. */
export function bonusSharesFor(shares: number, ratio: number | null): number {
  if (!ratio || ratio <= 0 || shares <= 0) return 0;
  // The small nudge stops 100 x 0.29 = 28.999... rounding down a whole share.
  return Math.floor(shares * ratio + 1e-9);
}

export function entitlement(action: CorporateAction, rows: readonly TransactionRow[]): Entitlement {
  const shares = sharesHeldOn(rows, action.symbol, action.record_date);
  const cash = action.kind === "cash_dividend" ? (action.cash_per_share_bdt ?? 0) : 0;
  return {
    sharesOnRecordDate: shares,
    cashBdt: roundBdt(shares * cash),
    bonusShares: action.kind === "stock_dividend" ? bonusSharesFor(shares, action.bonus_ratio) : 0,
  };
}

function byRecordDate(actions: readonly CorporateAction[]): CorporateAction[] {
  return [...actions].sort((a, b) => a.record_date.localeCompare(b.record_date) || a.id.localeCompare(b.id));
}

/**
 * Bonus shares as zero-cost buys, credited at 11:00 Dhaka on `paid_on`.
 * Merged with the ledger before `aggregateHoldings`, they add shares without
 * adding cost, so the average cost falls by the bonus ratio. Only actions
 * credited by `asOf` count, and each one sees the bonus shares before it.
 */
export function bonusTransactions(
  actions: readonly CorporateAction[],
  rows: readonly TransactionRow[],
  asOf: string,
): TransactionRow[] {
  const out: TransactionRow[] = [];
  for (const a of byRecordDate(actions)) {
    if (a.kind !== "stock_dividend" || a.paid_on > asOf) continue;
    const { bonusShares } = entitlement(a, [...rows, ...out]);
    if (bonusShares <= 0) continue;
    out.push({
      id: `bonus-${a.id}`,
      created_at: new Date(`${a.paid_on}T11:00:00+06:00`).toISOString(),
      symbol: normalizeSymbol(a.symbol),
      side: "buy",
      quantity: bonusShares,
      price_per_share: 0,
      category: "bonus",
      fees_bdt: 0,
      account_type: "long_term",
    });
  }
  return out;
}

/** Pass the ledger with bonus rows merged, so a dividend after a bonus counts the bonus shares. */
export function dividendsFor(
  actions: readonly CorporateAction[],
  rows: readonly TransactionRow[],
  asOf: string,
): DividendView[] {
  return byRecordDate(actions)
    .filter((a) => a.kind === "cash_dividend")
    .map((a) => {
      const e = entitlement(a, rows);
      return {
        actionId: a.id,
        symbol: normalizeSymbol(a.symbol),
        record_date: a.record_date,
        paid_on: a.paid_on,
        shares: e.sharesOnRecordDate,
        cash_per_share_bdt: a.cash_per_share_bdt ?? 0,
        amountBdt: e.cashBdt,
        paid: a.paid_on <= asOf,
      };
    })
    .filter((d) => d.shares > 0);
}

/** Cash dividends paid by `asOf`. */
export function dividendIncomeBdt(dividends: readonly DividendView[]): number {
  return roundBdt(dividends.filter((d) => d.paid).reduce((s, d) => s + d.amountBdt, 0));
}
