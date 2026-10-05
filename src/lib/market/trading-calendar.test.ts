import { describe, it, expect } from "vitest";
import {
  addDseTradingDays,
  daysBetweenYmd,
  dhakaToday,
  formatDseDate,
  formatDseDateRange,
  isDseTradingDay,
  laterYmd,
  nextDseTradingDay,
  parseYmd,
  prevDseTradingDay,
} from "./trading-calendar";

// 2026-08-02 is a Sunday; 2026-08-07 a Friday; 2026-08-08 a Saturday.
describe("isDseTradingDay", () => {
  it("trades Sunday through Thursday and is closed Friday and Saturday", () => {
    expect(isDseTradingDay("2026-08-02")).toBe(true); // Sun
    expect(isDseTradingDay("2026-08-06")).toBe(true); // Thu
    expect(isDseTradingDay("2026-08-07")).toBe(false); // Fri
    expect(isDseTradingDay("2026-08-08")).toBe(false); // Sat
  });

  it("rejects malformed dates rather than guessing", () => {
    expect(isDseTradingDay("not-a-date")).toBe(false);
    expect(parseYmd("2026-02-31")).toBeNull();
  });
});

describe("nextDseTradingDay / prevDseTradingDay", () => {
  it("leaves a trading day alone and rolls the weekend forward to Sunday, back to Thursday", () => {
    expect(nextDseTradingDay("2026-08-02")).toBe("2026-08-02");
    expect(prevDseTradingDay("2026-08-02")).toBe("2026-08-02");
    expect(nextDseTradingDay("2026-08-07")).toBe("2026-08-09"); // Fri → Sun
    expect(prevDseTradingDay("2026-08-08")).toBe("2026-08-06"); // Sat → Thu
  });
});

describe("addDseTradingDays", () => {
  it("does not count the anchor day itself, and skips the weekend", () => {
    // Sunday + 1 session is Monday, not Sunday: today's session is already
    // reflected in today's price.
    expect(addDseTradingDays("2026-08-02", 1)).toBe("2026-08-03");
    // Sun + 5 sessions = Mon, Tue, Wed, Thu, then Sun (Fri/Sat skipped).
    expect(addDseTradingDays("2026-08-02", 5)).toBe("2026-08-09");
  });

  it("collapses a non-positive count to the next tradeable day", () => {
    expect(addDseTradingDays("2026-08-07", 0)).toBe("2026-08-09"); // Fri → Sun
    expect(addDseTradingDays("2026-08-02", -3)).toBe("2026-08-02");
  });
});

describe("daysBetweenYmd", () => {
  it("counts calendar days, not sessions — forward, zero and negative alike", () => {
    // 2026-08-07 is a Friday and 08-08 a Saturday; both are closed but still count.
    expect(daysBetweenYmd("2026-08-06", "2026-08-09")).toBe(3);
    expect(daysBetweenYmd("2026-08-03", "2026-08-03")).toBe(0);
    expect(daysBetweenYmd("2026-08-03", "2026-07-30")).toBe(-4);
  });

  it("returns null for a malformed date", () => {
    expect(daysBetweenYmd("nope", "2026-08-03")).toBeNull();
    expect(daysBetweenYmd("2026-08-03", "")).toBeNull();
  });
});

describe("laterYmd", () => {
  it("takes the later date and tolerates a missing or junk second argument", () => {
    expect(laterYmd("2026-08-02", "2026-08-09")).toBe("2026-08-09");
    expect(laterYmd("2026-08-09", "2026-08-02")).toBe("2026-08-09");
    expect(laterYmd("2026-08-02", null)).toBe("2026-08-02");
    expect(laterYmd("2026-08-02", "garbage")).toBe("2026-08-02");
  });
});

describe("dhakaToday", () => {
  it("uses the exchange's calendar day, not UTC's", () => {
    // 22:00 UTC on 1 Aug is 04:00 on 2 Aug in Dhaka (UTC+6).
    expect(dhakaToday(new Date("2026-08-01T22:00:00Z"))).toBe("2026-08-02");
    expect(dhakaToday(new Date("2026-08-01T17:00:00Z"))).toBe("2026-08-01");
  });
});

describe("formatDseDate / formatDseDateRange", () => {
  it("formats a single day, with the year only on request", () => {
    expect(formatDseDate("2026-08-09")).toBe("9 Aug");
    expect(formatDseDate("2026-08-09", true)).toBe("9 Aug 2026");
  });

  it("collapses the month when both ends share it, and adds years only across one", () => {
    expect(formatDseDateRange("2026-08-09", "2026-08-13")).toBe("9–13 Aug");
    expect(formatDseDateRange("2026-12-28", "2027-01-03")).toBe(
      "28 Dec 2026 – 3 Jan 2027",
    );
  });
});
