import { computeTradeCommissionBdt } from "@/lib/fees/trade-commission";
import { barsBySymbol, latestQuote } from "@/lib/market/quotes";
import { roundBdt, type TransactionRow } from "@/lib/portfolio";
import { buildPortfolioView, dataUpTo, type PortfolioData, type PortfolioView } from "@/lib/portfolio-view";
import { positionWeights, sectorWeights, type RuleFinding } from "@/lib/rules";
import { normalizeSymbol } from "@/lib/symbol";

export type TradeIdea = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Defaults to the last close on the as-of date. */
  price?: number | null;
};

export type Snapshot = {
  totalMarketValue: number;
  holdings: { symbol: string; shares: number; marketValue: number | null; weightPct: number | null }[];
  sectors: { sector: string; weightPct: number }[];
  findings: RuleFinding[];
};

export type WhatIf =
  | {
      ok: true;
      asOf: string;
      trade: { symbol: string; side: "buy" | "sell"; quantity: number; price: number; grossBdt: number; commissionBdt: number };
      /** Cash the trade takes out of the account (negative for a sell, which brings cash in). */
      cashBdt: number;
      before: Snapshot;
      after: Snapshot;
      /** Findings after the trade that were not there before it. */
      newFindings: RuleFinding[];
    }
  | { ok: false; error: string };

/** What a finding is about, so the same broken rule before and after counts once. */
function findingKey(f: RuleFinding): string {
  if (f.kind === "max_position_weight") return `${f.kind}:${f.symbol}`;
  if (f.kind === "sector_target") return `${f.kind}:${f.sector}`;
  return `${f.kind}:${f.planId}`;
}

function snapshot(v: PortfolioView): Snapshot {
  return {
    totalMarketValue: v.totalMarketValue,
    holdings: v.holdings.map((h) => ({ symbol: h.symbol, shares: h.shares, marketValue: h.marketValue, weightPct: h.weightPct })),
    sectors: [...sectorWeights(positionWeights(v.holdings))].map(([sector, weightPct]) => ({ sector, weightPct })),
    findings: v.findings,
  };
}

/**
 * The portfolio before and after one hypothetical trade at the end of `asOf`.
 * Nothing is saved: the trade only exists inside this function.
 */
export function previewTrade(data: PortfolioData, asOf: string, idea: TradeIdea): WhatIf {
  const symbol = normalizeSymbol(idea.symbol);
  const quantity = Number(idea.quantity);
  if (!symbol) return { ok: false, error: "Symbol is required." };
  if (idea.side !== "buy" && idea.side !== "sell") return { ok: false, error: "Side must be buy or sell." };
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: "Quantity must be a whole number above zero." };

  const lastClose = latestQuote(barsBySymbol(dataUpTo(data, asOf).bars).get(symbol) ?? [])?.ltp ?? null;
  const given = idea.price === null || idea.price === undefined ? null : Number(idea.price);
  if (given !== null && (!Number.isFinite(given) || given <= 0)) return { ok: false, error: "Price must be above zero." };
  const price = given ?? lastClose;
  if (price === null) return { ok: false, error: `There is no price for ${symbol} on ${asOf}; type one in.` };

  const before = buildPortfolioView(data, asOf);
  const held = before.holdings.find((h) => h.symbol === symbol)?.shares ?? 0;
  if (idea.side === "sell" && quantity > held) {
    return { ok: false, error: `Cannot sell ${quantity} ${symbol}; you hold ${held}.` };
  }

  const commissionBdt = computeTradeCommissionBdt(quantity, price);
  const row: TransactionRow = {
    id: "what-if",
    // After the session closes, so it sorts after any real trade that day.
    created_at: new Date(`${asOf}T14:30:00+06:00`).toISOString(),
    symbol,
    side: idea.side,
    quantity,
    price_per_share: price,
    category: null,
    fees_bdt: commissionBdt,
    account_type: "long_term",
  };
  const after = buildPortfolioView({ ...data, transactions: [...data.transactions, row] }, asOf);

  const grossBdt = roundBdt(quantity * price);
  const seen = new Set(before.findings.map(findingKey));
  return {
    ok: true,
    asOf,
    trade: { symbol, side: idea.side, quantity, price, grossBdt, commissionBdt },
    cashBdt: idea.side === "buy" ? roundBdt(grossBdt + commissionBdt) : roundBdt(-(grossBdt - commissionBdt)),
    before: snapshot(before),
    after: snapshot(after),
    newFindings: after.findings.filter((f) => !seen.has(findingKey(f))),
  };
}
