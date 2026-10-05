import { attribute, type Attribution } from "@/lib/attribution";
import type { SectorIndexBar } from "@/lib/data-types";
import { indexChangeOverSessions, indexSeries } from "@/lib/market/index";
import { barsBySymbol } from "@/lib/market/quotes";
import { sectorChange, sectorSeries } from "@/lib/market/sector-index";
import { buildPortfolioView, dataUpTo, type PortfolioData } from "@/lib/portfolio-view";

/** Attribution of the portfolio's move over `sessions` ending on `asOf`. */
export function attributionAsOf(
  data: PortfolioData,
  sectorBars: readonly SectorIndexBar[],
  asOf: string,
  sessions: number,
): Attribution {
  const view = buildPortfolioView(data, asOf);
  const upTo = dataUpTo(data, asOf);
  return attribute({
    holdings: view.holdings,
    barsBySymbol: barsBySymbol(upTo.bars),
    indexBars: indexSeries(upTo.indexBars, "DSEX"),
    sectorIndexBars: sectorBars.filter((b) => b.bar_date <= asOf),
    sessions,
  });
}

export type SectorMove = { sector: string; close: number; fromDate: string; toDate: string; changePct: number };

/** Every sector index's move over `sessions` ending on `asOf`, plus DSEX, largest fall first. */
export function sectorMovesAsOf(
  data: PortfolioData,
  sectorBars: readonly SectorIndexBar[],
  asOf: string,
  sessions: number,
): { asOf: string; sessions: number; sectors: SectorMove[]; dsex: SectorMove | null } {
  const series = sectorSeries(sectorBars);
  const names = [...new Set(sectorBars.map((b) => b.sector))];
  const sectors = names
    .map((sector) => {
      const c = sectorChange(series, sector, asOf, sessions);
      return c ? { sector, close: c.toClose, fromDate: c.fromDate, toDate: c.toDate, changePct: c.changePct } : null;
    })
    .filter((s): s is SectorMove => s !== null)
    .sort((a, b) => a.changePct - b.changePct);
  const d = indexChangeOverSessions(indexSeries(dataUpTo(data, asOf).indexBars, "DSEX"), sessions);
  return {
    asOf,
    sessions,
    sectors,
    dsex: d ? { sector: "DSEX", close: d.toClose, fromDate: d.fromDate, toDate: d.toDate, changePct: d.changePct } : null,
  };
}
