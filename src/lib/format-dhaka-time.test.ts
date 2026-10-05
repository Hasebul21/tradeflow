import { describe, it, expect } from "vitest";
import { formatDhakaDateTime } from "./format-dhaka-time";

describe("formatDhakaDateTime", () => {
  it("renders UTC instants on the Dhaka wall clock (UTC+6)", () => {
    expect(formatDhakaDateTime("2026-08-12T15:00:00Z")).toBe("12 Aug, 9:00 pm");
    // Crossing midnight: 20:00 UTC is already the next Dhaka day.
    expect(formatDhakaDateTime("2026-08-12T20:00:00Z")).toBe("13 Aug, 2:00 am");
  });

  it("returns null for missing or unparseable input instead of 'Invalid Date'", () => {
    expect(formatDhakaDateTime(null)).toBeNull();
    expect(formatDhakaDateTime(undefined)).toBeNull();
    expect(formatDhakaDateTime("")).toBeNull();
    expect(formatDhakaDateTime("not a date")).toBeNull();
  });
});
