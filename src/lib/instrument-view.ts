import type { Announcement, CorporateAction, Fundamental, Instrument, JournalEntry, SectorIndexBar } from "@/lib/data-types";
import { summariseFundamentals, type FundamentalsSummary } from "@/lib/fundamentals";
import { barsBySymbol, changeOverSessions, latestQuote, type Quote } from "@/lib/market/quotes";
import { sectorChange, sectorSeries } from "@/lib/market/sector-index";
import { buildPortfolioView, dataUpTo, type HoldingView, type PortfolioData } from "@/lib/portfolio-view";
import { normalizeSymbol } from "@/lib/symbol";

export type InstrumentView = {
  instrument: Instrument;
  asOf: string;
  quote: Quote | null;
  weekChangePct: number | null;
  sectorWeekChangePct: number | null;
  holding: HoldingView | null;
  fundamentals: FundamentalsSummary;
  announcements: Announcement[];
  journal: (JournalEntry & { trade_date: string; side: "buy" | "sell"; quantity: number; price: number })[];
  actions: CorporateAction[];
};

export type InstrumentRow = {
  symbol: string;
  name: string;
  sector: string;
  ltp: number | null;
  weekChangePct: number | null;
  sharesHeld: number;
  latestEps: number | null;
  trailingPe: number | null;
};

/** One row per instrument for the list page, as of a session. */
export function instrumentRows(data: PortfolioData, fundamentals: readonly Fundamental[], asOf: string): InstrumentRow[] {
  const grouped = barsBySymbol(dataUpTo(data, asOf).bars);
  const held = new Map(buildPortfolioView(data, asOf).holdings.map((h) => [h.symbol, h.shares]));
  return [...data.instruments.values()]
    .map((i) => {
      const bars = grouped.get(i.symbol) ?? [];
      const ltp = latestQuote(bars)?.ltp ?? null;
      const f = summariseFundamentals(fundamentals, i.symbol, asOf, ltp);
      return {
        symbol: i.symbol,
        name: i.name,
        sector: i.sector,
        ltp,
        weekChangePct: changeOverSessions(bars, 5)?.changePct ?? null,
        sharesHeld: held.get(i.symbol) ?? 0,
        latestEps: f.latest?.eps_bdt ?? null,
        trailingPe: f.trailingPe,
      };
    })
    .sort((a, b) => a.sector.localeCompare(b.sector) || a.symbol.localeCompare(b.symbol));
}

/** Everything known about one symbol as of a session: price, holding, fundamentals, news and notes. */
export function instrumentView(args: {
  data: PortfolioData;
  symbol: string;
  asOf: string;
  fundamentals: readonly Fundamental[];
  sectorBars: readonly SectorIndexBar[];
  announcements: readonly Announcement[];
  journal: readonly JournalEntry[];
}): InstrumentView | null {
  const symbol = normalizeSymbol(args.symbol);
  const instrument = args.data.instruments.get(symbol);
  if (!instrument) return null;
  const upTo = dataUpTo(args.data, args.asOf);
  const bars = barsBySymbol(upTo.bars).get(symbol) ?? [];
  const quote = latestQuote(bars);
  const trades = new Map(upTo.transactions.filter((t) => t.symbol === symbol).map((t) => [t.id, t]));
  return {
    instrument,
    asOf: args.asOf,
    quote,
    weekChangePct: changeOverSessions(bars, 5)?.changePct ?? null,
    sectorWeekChangePct: sectorChange(sectorSeries(args.sectorBars), instrument.sector, args.asOf, 5)?.changePct ?? null,
    holding: buildPortfolioView(args.data, args.asOf).holdings.find((h) => h.symbol === symbol) ?? null,
    fundamentals: summariseFundamentals(args.fundamentals, symbol, args.asOf, quote?.ltp ?? null),
    announcements: args.announcements.filter(
      (a) => normalizeSymbol(a.symbol) === symbol && new Date(a.published_at).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" }) <= args.asOf,
    ),
    journal: args.journal
      .filter((e) => trades.has(e.transaction_id))
      .map((e) => {
        const t = trades.get(e.transaction_id)!;
        return { ...e, trade_date: t.created_at, side: t.side, quantity: Number(t.quantity), price: Number(t.price_per_share) };
      }),
    actions: upTo.actions.filter((a) => normalizeSymbol(a.symbol) === symbol),
  };
}
