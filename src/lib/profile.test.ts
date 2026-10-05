import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, loadProfile, saveProfile, validateProfile } from "./profile";

const valid = {
  display_name: " Owner ",
  base_currency: "bdt",
  risk_tolerance: "low",
  review_day: "Thursday",
  investment_goal: "Income",
  excluded_sectors: "Bank, Cement, Bank",
  notes: "",
};

describe("profile", () => {
  it("cleans a valid profile", () => {
    expect(validateProfile(valid)).toEqual({
      ok: true,
      profile: {
        display_name: "Owner",
        base_currency: "BDT",
        risk_tolerance: "low",
        review_day: "Thursday",
        investment_goal: "Income",
        excluded_sectors: ["Bank", "Cement"],
        notes: null,
      },
    });
  });

  it("rejects bad values with a clear message", () => {
    expect(validateProfile({ ...valid, display_name: "" })).toEqual({ ok: false, error: "Display name is required." });
    expect(validateProfile({ ...valid, risk_tolerance: "reckless" }).ok).toBe(false);
    expect(validateProfile({ ...valid, review_day: "Someday" }).ok).toBe(false);
    expect(validateProfile({ ...valid, base_currency: "TAKA" }).ok).toBe(false);
  });

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tradeflow-"));
    process.env.TRADEFLOW_DATA_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.TRADEFLOW_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to defaults and round-trips a save", async () => {
    expect(await loadProfile()).toEqual(DEFAULT_PROFILE);
    const result = validateProfile(valid);
    if (!result.ok) throw new Error(result.error);
    await saveProfile(result.profile);
    expect(await loadProfile()).toEqual(result.profile);
  });
});
