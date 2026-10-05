import type { Profile, RiskTolerance } from "@/lib/data-types";
import { readJson, writeJson } from "@/lib/store";

export const RISK_TOLERANCES: readonly RiskTolerance[] = ["low", "medium", "high"];
export const REVIEW_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const DEFAULT_PROFILE: Profile = {
  display_name: "Owner",
  base_currency: "BDT",
  risk_tolerance: "medium",
  review_day: "Thursday",
  investment_goal: "",
  excluded_sectors: [],
  notes: null,
};

export type ProfileResult = { ok: true; profile: Profile } | { ok: false; error: string };

/** Checks a submitted profile and returns it cleaned, or the first problem found. */
export function validateProfile(input: Record<string, unknown>): ProfileResult {
  const text = (key: string) => String(input[key] ?? "").trim();
  const displayName = text("display_name");
  const currency = text("base_currency").toUpperCase();
  const risk = text("risk_tolerance");
  const reviewDay = text("review_day");
  const raw = input.excluded_sectors;
  const excluded = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  if (!displayName) return { ok: false, error: "Display name is required." };
  if (displayName.length > 60) return { ok: false, error: "Display name must be 60 characters or fewer." };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Base currency must be a three-letter code such as BDT." };
  if (!(RISK_TOLERANCES as readonly string[]).includes(risk)) return { ok: false, error: "Risk tolerance must be low, medium or high." };
  if (!(REVIEW_DAYS as readonly string[]).includes(reviewDay)) return { ok: false, error: "Review day must be a day of the week." };

  return {
    ok: true,
    profile: {
      display_name: displayName,
      base_currency: currency,
      risk_tolerance: risk as RiskTolerance,
      review_day: reviewDay,
      investment_goal: text("investment_goal"),
      excluded_sectors: [...new Set(excluded)],
      notes: text("notes") || null,
    },
  };
}

export async function loadProfile(): Promise<Profile> {
  return { ...DEFAULT_PROFILE, ...(await readJson<Partial<Profile>>("profile", {})) };
}

export async function saveProfile(profile: Profile): Promise<void> {
  await writeJson("profile", profile);
}
