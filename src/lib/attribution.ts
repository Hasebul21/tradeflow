import type { DailyBar, IndexBar, SectorIndexBar } from "@/lib/data-types";
import { indexChangeOverSessions } from "@/lib/market/index";
import { sectorChange, sectorSeries } from "@/lib/market/sector-index";
import { changeOverSessions } from "@/lib/market/quotes";
import { roundBdt } from "@/lib/portfolio";
import { normalizeSectorLabel } from "@/lib/sector-targets";

export type Contribution = {
  /** BDT the position added to or took from the portfolio over the window. */
  contributionBdt: number;
  /** The same as a share of the portfolio's value at the start of the window, in points. */
  contributionPts: number;
};

/**
 * A stock is "in line with sector" when its move is within this many
 * percentage points of its sector index's move over the same sessions, and
 * "stock-specific" otherwise. A plain threshold, not a judgement of why.
 */
export const IN_LINE_THRESHOLD_PTS = 2;

export type SectorComparison = "stock-specific" | "in line with sector";

export type HoldingContribution = Contribution & {
  symbol: string;
  sector: string;
  shares: number;
  fromClose: number;
  toClose: number;
  changePct: number;
  /** The holding's sector index over the same sessions; null without sector data. */
  sectorChangePct: number | null;
  /** DSEX over the same sessions. */
  indexChangePct: number | null;
  /** Stock move minus sector move, in points. */
  versusSectorPts: number | null;
  comparison: SectorComparison | null;
};

export function compareWithSector(stockPct: number, sectorPct: number | null): SectorComparison | null {
  if (sectorPct === null) return null;
  return Math.abs(stockPct - sectorPct) <= IN_LINE_THRESHOLD_PTS ? "in line with sector" : "stock-specific";
}

export type SectorContribution = Contribution & { sector: string };

export type Attribution = {
  sessions: number;
  fromDate: string | null;
  toDate: string | null;
  startValueBdt: number;
  changeBdt: number;
  changePct: number | null;
  holdings: HoldingContribution[];
  sectors: SectorContribution[];
  /** Holdings left out because their price history is shorter than the window. */
  unpriced: string[];
  indexChangePct: number | null;
  /** Portfolio move minus index move, in percentage points. */
  differencePts: number | null;
};

/**
 * Splits the portfolio's close-to-close move over the last `sessions` bars
 * into each holding's and each sector's share. Like the week figure on the
 * portfolio page, it uses the shares held at the end of the window, so the
 * parts add up to the whole by construction. It is arithmetic only.
 */
export function attribute(args: {
  holdings: ReadonlyArray<{ symbol: string; sector: string | null; shares: number }>;
  barsBySymbol: ReadonlyMap<string, readonly DailyBar[]>;
  indexBars: readonly IndexBar[];
  sectorIndexBars?: readonly SectorIndexBar[];
  sessions?: number;
}): Attribution {
  const sessions = args.sessions ?? 5;
  const index = indexChangeOverSessions(args.indexBars, sessions);
  const sectors = sectorSeries(args.sectorIndexBars ?? []);
  const rows: Omit<HoldingContribution, "contributionPts">[] = [];
  const unpriced: string[] = [];
  let fromDate: string | null = null;
  let toDate: string | null = null;

  for (const h of args.holdings) {
    const change = changeOverSessions(args.barsBySymbol.get(h.symbol) ?? [], sessions);
    if (!change) {
      unpriced.push(h.symbol);
      continue;
    }
    fromDate ??= change.fromDate;
    toDate ??= change.toDate;
    const sectorPct = sectorChange(sectors, h.sector, change.toDate, sessions)?.changePct ?? null;
    rows.push({
      symbol: h.symbol,
      sector: normalizeSectorLabel(h.sector),
      shares: h.shares,
      fromClose: change.fromClose,
      toClose: change.toClose,
      changePct: change.changePct,
      contributionBdt: (change.toClose - change.fromClose) * h.shares,
      sectorChangePct: sectorPct,
      indexChangePct: index?.changePct ?? null,
      versusSectorPts: sectorPct === null ? null : change.changePct - sectorPct,
      comparison: compareWithSector(change.changePct, sectorPct),
    });
  }

  const startValue = rows.reduce((s, r) => s + r.fromClose * r.shares, 0);
  const points = (bdt: number) => (startValue > 0 ? (bdt / startValue) * 100 : 0);
  const change = rows.reduce((s, r) => s + r.contributionBdt, 0);

  const bySector = new Map<string, number>();
  for (const r of rows) bySector.set(r.sector, (bySector.get(r.sector) ?? 0) + r.contributionBdt);

  const changePct = startValue > 0 ? points(change) : null;

  return {
    sessions,
    fromDate,
    toDate,
    startValueBdt: roundBdt(startValue),
    changeBdt: roundBdt(change),
    changePct,
    holdings: rows
      .map((r) => ({ ...r, contributionBdt: roundBdt(r.contributionBdt), contributionPts: points(r.contributionBdt) }))
      .sort((a, b) => a.contributionBdt - b.contributionBdt),
    sectors: [...bySector]
      .map(([sector, bdt]) => ({ sector, contributionBdt: roundBdt(bdt), contributionPts: points(bdt) }))
      .sort((a, b) => a.contributionBdt - b.contributionBdt),
    unpriced,
    indexChangePct: index?.changePct ?? null,
    differencePts: changePct !== null && index ? changePct - index.changePct : null,
  };
}
