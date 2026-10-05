/**
 * Sector name normalisation shared by the sector-investments feature (the
 * sector target allocation feature that used to share this module was
 * removed; these two helpers stayed because sector-investments.ts still
 * calls them).
 */

const UNKNOWN_SECTOR_LABEL = "Unknown";
export const SECTOR_TARGET_MAX_ROWS = 30;

/** Trim and collapse internal whitespace; preserve original casing for display. */
export function normalizeSectorLabel(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  return s.length > 0 ? s : UNKNOWN_SECTOR_LABEL;
}

/** Case-insensitive key for matching across portfolio rows / target rows. */
export function sectorMatchKey(label: string): string {
  return normalizeSectorLabel(label).toLowerCase();
}
