import { describe, expect, it } from "vitest";
import type { Announcement } from "@/lib/data-types";
import { filterAnnouncements, publishedYmd, sortAnnouncementsByLatest } from "./announcements";

function announcement(id: string, symbol: string, published_at: string): Announcement {
  return { id, symbol, published_at, category: "other", title: "t", body: "b", price_sensitive: false };
}

describe("announcements", () => {
  const rows = [
    announcement("a-001", "GP", "2026-09-24T09:00:00.000Z"),
    announcement("a-002", "BXPHARMA", "2026-09-29T05:00:00.000Z"),
    // 00:30 Dhaka on 1 Oct is still 30 Sep in UTC.
    announcement("a-003", "bxpharma", "2026-09-30T18:30:00.000Z"),
  ];

  it("dates an announcement by its Dhaka day", () => {
    expect(publishedYmd(rows[2])).toBe("2026-10-01");
  });

  it("filters by symbol, case-insensitively", () => {
    expect(filterAnnouncements(rows, { symbols: ["BXPHARMA"] }).map((a) => a.id)).toEqual(["a-002", "a-003"]);
    expect(filterAnnouncements(rows, { symbols: [] })).toHaveLength(3);
  });

  it("filters by an inclusive date range", () => {
    expect(filterAnnouncements(rows, { from: "2026-09-29", to: "2026-09-30" }).map((a) => a.id)).toEqual(["a-002"]);
    expect(filterAnnouncements(rows, { from: "2026-10-01" }).map((a) => a.id)).toEqual(["a-003"]);
  });

  it("sorts newest first", () => {
    expect(sortAnnouncementsByLatest(rows).map((a) => a.id)).toEqual(["a-003", "a-002", "a-001"]);
  });
});
