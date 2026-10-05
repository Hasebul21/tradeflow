import type { Announcement } from "@/lib/data-types";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { readJson } from "@/lib/store";
import { normalizeSymbol } from "@/lib/symbol";

export type AnnouncementFilter = {
  /** One symbol, or several; empty means every symbol. */
  symbols?: readonly string[];
  /** `YYYY-MM-DD`, inclusive, compared with the Dhaka date of `published_at`. */
  from?: string | null;
  to?: string | null;
};

/** The Dhaka calendar day an announcement came out on. */
export function publishedYmd(a: Announcement): string {
  return dhakaToday(new Date(a.published_at));
}

/** Newest first, then id for a stable order. */
export function sortAnnouncementsByLatest(rows: readonly Announcement[]): Announcement[] {
  return [...rows].sort((a, b) => b.published_at.localeCompare(a.published_at) || b.id.localeCompare(a.id));
}

export function filterAnnouncements(rows: readonly Announcement[], filter: AnnouncementFilter): Announcement[] {
  const wanted = new Set((filter.symbols ?? []).map(normalizeSymbol).filter(Boolean));
  return rows.filter((a) => {
    if (wanted.size > 0 && !wanted.has(normalizeSymbol(a.symbol))) return false;
    const day = publishedYmd(a);
    if (filter.from && day < filter.from) return false;
    if (filter.to && day > filter.to) return false;
    return true;
  });
}

export async function loadAnnouncements(): Promise<Announcement[]> {
  return sortAnnouncementsByLatest(await readJson<Announcement[]>("announcements", []));
}
