import { bonusTransactions, dividendIncomeBdt, dividendsFor, type DividendView } from "@/lib/corporate-actions";
import {
  loadBars,
  loadContributions,
  loadCorporateActions,
  loadIndexBars,
  loadInstruments,
  loadRules,
} from "@/lib/data";
import type {
  Contribution,
  CorporateAction,
  DailyBar,
  IndexBar,
  Instrument,
  Rules,
} from "@/lib/data-types";
import { indexChangeOverSessions, indexSeries, indexUpTo } from "@/lib/market/index";
import { barsBySymbol, changeOverSessions, latestQuote } from "@/lib/market/quotes";
import { dhakaToday, parseYmd, prevDseTradingDay } from "@/lib/market/trading-calendar";
import {
  aggregateHoldings,
  computePortfolioSummary,
  roundBdt,
  sortHoldingsByTotalInvestedDesc,
  totalRealizedProfitLossBdt,
  type HoldingRow,
  type PortfolioSummary,
  type TransactionRow,
} from "@/lib/portfolio";
import { evaluateRules, positionWeights, type RuleFinding } from "@/lib/rules";
import { loadTransactions } from "@/lib/transactions";

export type HoldingView = HoldingRow & {
  name: string | null;
  sector: string | null;
  /** Latest close; null when the symbol has no bars. */
  ltp: number | null;
  asOf: string | null;
  marketValue: number | null;
  /** (ltp − break-even) × shares, so it already carries both commissions. */
  unrealizedPl: number | null;
  dayChangePct: number | null;
  /** Last five sessions, close to close. */
  weekChangePct: number | null;
  /** The same move in money terms for the shares held now. */
  weekChangeBdt: number | null;
  weightPct: number | null;
};

export type PortfolioView = {
  /** The latest bar date across all holdings; what "today" means in this view. */
  asOf: string | null;
  holdings: HoldingView[];
  summary: PortfolioSummary;
  totalMarketValue: number;
  weekChangeBdt: number;
  weekChangePct: number | null;
  totalContributions: number;
  findings: RuleFinding[];
  rules: Rules;
  /** Cash dividends paid by the as-of date. */
  dividendIncomeBdt: number;
  /** Every cash dividend the portfolio was entitled to, paid or not yet. */
  dividends: DividendView[];
  /** Bonus shares credited so far, as zero-cost buys. Already folded into `holdings`. */
  bonusShares: { symbol: string; shares: number; credited_on: string }[];
  /** DSEX over the same five sessions as `weekChangePct`; null without index data. */
  market: { index: string; asOf: string; close: number; weekChangePct: number } | null;
};

export const WEEK_SESSIONS = 5;

/** Everything the portfolio view is built from, as loaded from data/. */
export type PortfolioData = {
  transactions: TransactionRow[];
  bars: DailyBar[];
  instruments: Map<string, Instrument>;
  rules: Rules;
  contributions: Contribution[];
  actions: CorporateAction[];
  indexBars: IndexBar[];
};

export type AsOfResult = { ok: true; asOf: string } | { ok: false; error: string };

/** The Dhaka calendar day of an ISO instant. */
const dayOf = (iso: string) => dhakaToday(new Date(iso));

/**
 * The trading day a view is built for. No request means the latest bar. A
 * Friday or Saturday falls back to Thursday, and a holiday with no bars to
 * the last session before it. Dates outside the bars are an error.
 */
export function resolveAsOf(bars: readonly DailyBar[], requested?: string | null): AsOfResult {
  const dates = [...new Set(bars.map((b) => b.bar_date))].sort();
  if (dates.length === 0) return { ok: false, error: "There are no price bars in the data." };
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!requested) return { ok: true, asOf: last };
  if (!parseYmd(requested)) return { ok: false, error: "as_of must be a date as YYYY-MM-DD." };
  if (requested > last) return { ok: false, error: `as_of ${requested} is after the data, which ends on ${last}.` };
  const day = prevDseTradingDay(requested);
  const session = [...dates].reverse().find((d) => d <= day);
  if (!session || requested < first) {
    return { ok: false, error: `as_of ${requested} is before the data, which starts on ${first}.` };
  }
  return { ok: true, asOf: session };
}

/** The data as it stood at the end of `asOf`: later trades, bars, deposits and plans are dropped. */
export function dataUpTo(data: PortfolioData, asOf: string): PortfolioData {
  return {
    ...data,
    transactions: data.transactions.filter((t) => dayOf(t.created_at) <= asOf),
    bars: data.bars.filter((b) => b.bar_date <= asOf),
    contributions: data.contributions.filter((c) => dayOf(c.created_at) <= asOf),
    rules: { ...data.rules, trade_plans: data.rules.trade_plans.filter((p) => dayOf(p.created_at) <= asOf) },
    actions: data.actions.filter((a) => a.record_date <= asOf),
    indexBars: indexUpTo(data.indexBars, asOf),
  };
}

/**
 * The real ledger plus bonus shares as zero-cost buys. Bonus rows carry the
 * category "bonus", which `aggregateHoldings` would copy onto the holding, so
 * the caller puts back the category from the real ledger.
 */
export function withBonusShares(
  transactions: TransactionRow[],
  actions: readonly CorporateAction[],
  asOf: string,
): TransactionRow[] {
  return [...transactions, ...bonusTransactions(actions, transactions, asOf)];
}

export async function loadPortfolioData(): Promise<PortfolioData> {
  const [transactions, bars, instruments, rules, contributions, actions, indexBars] = await Promise.all([
    loadTransactions(),
    loadBars(),
    loadInstruments(),
    loadRules(),
    loadContributions(),
    loadCorporateActions(),
    loadIndexBars(),
  ]);
  return { transactions, bars, instruments, rules, contributions, actions, indexBars };
}

/** The portfolio at the end of `asOf` (a resolved trading day), from data loaded once. Pure. */
export function buildPortfolioView(all: PortfolioData, asOf: string): PortfolioView {
  const { transactions: ledgerRows, bars, instruments, rules, contributions, actions, indexBars } = dataUpTo(all, asOf);

  const transactions = withBonusShares(ledgerRows, actions, asOf);
  const realCategory = new Map(aggregateHoldings(ledgerRows).map((h) => [h.symbol, h.category]));
  const grouped = barsBySymbol(bars);
  const ledger = sortHoldingsByTotalInvestedDesc(
    aggregateHoldings(transactions).map((h) => ({ ...h, category: realCategory.get(h.symbol) ?? null })),
  );

  const priced = ledger.map((h) => {
    const symbolBars = grouped.get(h.symbol) ?? [];
    const quote = latestQuote(symbolBars);
    const week = changeOverSessions(symbolBars, WEEK_SESSIONS);
    const info = instruments.get(h.symbol);
    const ltp = quote?.ltp ?? null;
    const marketValue = ltp === null ? null : roundBdt(ltp * h.shares);
    return {
      ...h,
      name: info?.name ?? null,
      sector: info?.sector ?? h.category ?? null,
      ltp,
      asOf: quote?.asOf ?? null,
      marketValue,
      unrealizedPl: ltp === null ? null : roundBdt((ltp - h.breakEvenPrice) * h.shares),
      dayChangePct: quote?.dayChangePct ?? null,
      weekChangePct: week?.changePct ?? null,
      weekChangeBdt: week ? roundBdt((week.toClose - week.fromClose) * h.shares) : null,
    };
  });

  const weights = new Map(positionWeights(priced).map((w) => [w.symbol, w.weightPct]));
  const holdings: HoldingView[] = priced.map((h) => ({ ...h, weightPct: weights.get(h.symbol) ?? null }));

  const ltpBySymbol = new Map(holdings.map((h) => [h.symbol, h.ltp]));
  const summary = computePortfolioSummary(ledger, totalRealizedProfitLossBdt(transactions), ltpBySymbol);

  const totalMarketValue = roundBdt(holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0));
  const weekChangeBdt = roundBdt(holdings.reduce((s, h) => s + (h.weekChangeBdt ?? 0), 0));
  const weekStartValue = totalMarketValue - weekChangeBdt;
  const weekChangePct = weekStartValue > 0 ? (weekChangeBdt / weekStartValue) * 100 : null;

  const latest = holdings.reduce<string | null>((max, h) => {
    if (!h.asOf) return max;
    return max === null || h.asOf > max ? h.asOf : max;
  }, null);

  const dividends = dividendsFor(actions, transactions, asOf);
  const dsexWeek = indexChangeOverSessions(indexSeries(indexBars, "DSEX"), WEEK_SESSIONS);

  return {
    asOf: latest,
    holdings,
    summary,
    totalMarketValue,
    weekChangeBdt,
    weekChangePct,
    totalContributions: roundBdt(contributions.reduce((s, c) => s + c.amount_bdt, 0)),
    findings: evaluateRules({ rows: holdings, ltpBySymbol, rules }),
    rules,
    dividendIncomeBdt: dividendIncomeBdt(dividends),
    dividends,
    bonusShares: transactions
      .filter((t) => t.category === "bonus")
      .map((t) => ({ symbol: t.symbol, shares: Number(t.quantity), credited_on: dayOf(t.created_at) })),
    market: dsexWeek
      ? { index: "DSEX", asOf: dsexWeek.toDate, close: dsexWeek.toClose, weekChangePct: dsexWeek.changePct }
      : null,
  };
}

/** `resolveAsOf`, except that an empty data folder with no request still gets an (empty) view for today. */
export function resolveViewAsOf(data: PortfolioData, requested?: string | null): AsOfResult {
  if (!requested && data.bars.length === 0) return { ok: true, asOf: dhakaToday() };
  return resolveAsOf(data.bars, requested);
}

/** The view as of `requested` (default: the latest session). Throws on a date outside the data. */
export async function loadPortfolioView(requested?: string | null): Promise<PortfolioView> {
  const data = await loadPortfolioData();
  const resolved = resolveViewAsOf(data, requested);
  if (!resolved.ok) throw new Error(resolved.error);
  return buildPortfolioView(data, resolved.asOf);
}

/** The first and last session in the data, for date pickers. Null without bars. */
export function barRange(bars: readonly DailyBar[]): { first: string; last: string } | null {
  if (bars.length === 0) return null;
  let first = bars[0].bar_date;
  let last = first;
  for (const b of bars) {
    if (b.bar_date < first) first = b.bar_date;
    if (b.bar_date > last) last = b.bar_date;
  }
  return { first, last };
}
