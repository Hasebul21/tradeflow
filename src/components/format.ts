import { formatBdt, formatShares } from "@/lib/format-bdt";

type Maybe = number | null | undefined;

export function money(n: Maybe): string {
  return n === null || n === undefined ? "—" : formatBdt(n);
}

export function signedMoney(n: Maybe): string {
  if (n === null || n === undefined) return "—";
  return `${n > 0 ? "+" : ""}${formatBdt(n)}`;
}

/** Signed, one decimal place: `+1.2%`. A value that rounds to zero shows as `0.0%`. */
export function pct(n: Maybe): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? "+" : ""}${(r === 0 ? 0 : r).toFixed(1)}%`;
}

/** Percentage points, signed, one decimal place: `+0.4 pts`. */
export function pts(n: Maybe): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? "+" : ""}${(r === 0 ? 0 : r).toFixed(1)} pts`;
}

export function plainPct(n: Maybe): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`;
}

/** CSS class for a signed number: green up, red down, muted when unknown. */
export function tone(n: Maybe): string {
  if (n === null || n === undefined) return "muted";
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "";
}

/** `12 Aug 2026` for a `YYYY-MM-DD` string or an ISO instant, in Dhaka time. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  // Some ICU versions write "Sept"; the rest of the app uses three-letter months.
  return d
    .toLocaleDateString("en-GB", {
      timeZone: value.length === 10 ? "UTC" : "Asia/Dhaka",
      day: "numeric",
      month: "short",
      year: "numeric",
    })
    .replace("Sept", "Sep");
}

export { formatShares };
