import type { SectorIndexBar } from "@/lib/data-types";
import { indexChangeOverSessions } from "@/lib/market/index";
import type { SessionChange } from "@/lib/market/quotes";
import { readJson } from "@/lib/store";
import { sectorMatchKey } from "@/lib/sector-targets";

/** Sector match key -> that sector's bars, oldest first. */
export function sectorSeries(bars: readonly SectorIndexBar[]): Map<string, SectorIndexBar[]> {
  const out = new Map<string, SectorIndexBar[]>();
  for (const b of bars) {
    const key = sectorMatchKey(b.sector);
    const list = out.get(key);
    if (list) list.push(b);
    else out.set(key, [b]);
  }
  for (const list of out.values()) list.sort((a, b) => a.bar_date.localeCompare(b.bar_date));
  return out;
}

/** A sector index's change over the last `sessions` bars up to `asOf`. */
export function sectorChange(
  series: ReadonlyMap<string, readonly SectorIndexBar[]>,
  sector: string | null,
  asOf: string,
  sessions: number,
): SessionChange | null {
  if (!sector) return null;
  const bars = (series.get(sectorMatchKey(sector)) ?? []).filter((b) => b.bar_date <= asOf);
  return indexChangeOverSessions(
    bars.map((b) => ({ index: b.sector, bar_date: b.bar_date, close: b.close })),
    sessions,
  );
}

export async function loadSectorIndexBars(): Promise<SectorIndexBar[]> {
  return readJson<SectorIndexBar[]>("sector_index_bars", []);
}
