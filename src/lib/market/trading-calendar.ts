/**
 * Dhaka Stock Exchange trading calendar.
 *
 * The DSE trades **Sunday–Thursday**; Friday and Saturday are the weekend. That
 * is the whole of the calendar we can know for certain: DSE publishes holidays
 * (Eid, national days) as PDF circulars, not as anything machine-readable, and
 * the historical bars only tell us about sessions that already happened. So a
 * projected date here is an estimate that slips by roughly the number of public
 * holidays that fall inside the window — a real risk around Eid, negligible for
 * most of the year.
 *
 * Dates are plain `YYYY-MM-DD` strings and every calculation runs in UTC, so a
 * server in Dhaka, Oslo, or us-east-1 produces the same answer, and the string
 * a Server Component renders is byte-identical to the one the client hydrates.
 */

/**
 * Calendar days per trading day on a Sun–Thu week (7/5). The horizon models
 * pace in sessions; this converts to the wall calendar. Matches the factor the
 * short-horizon logic uses elsewhere (see CLAUDE.md, "Money & market
 * conventions").
 */
export const DSE_WEEK_CALENDAR_FACTOR = 7 / 5;

const MS_PER_DAY = 86_400_000;

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Short month names — spelled out so output never depends on ICU/locale data. */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Parse `YYYY-MM-DD` into a UTC-midnight Date. Null when malformed. */
export function parseYmd(ymd: string): Date | null {
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible days that Date silently rolls over (e.g. 2026-02-31).
  if (date.getUTCMonth() !== Number(mo) - 1) return null;
  return date;
}

/** Format a UTC Date back to `YYYY-MM-DD`. */
export function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's date in Asia/Dhaka as `YYYY-MM-DD` — the exchange's local day. */
export function dhakaToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is also the Postgres `date` literal.
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
}

/** True when `ymd` falls Sun–Thu. Public holidays are not modelled. */
export function isDseTradingDay(ymd: string): boolean {
  const d = parseYmd(ymd);
  if (!d) return false;
  const dow = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  return dow <= 4;
}

/** `ymd` itself when it is a trading day, otherwise the next one (Fri/Sat → Sun). */
export function nextDseTradingDay(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  let t = d.getTime();
  while (new Date(t).getUTCDay() > 4) t += MS_PER_DAY;
  return toYmd(new Date(t));
}

/** `ymd` itself when it is a trading day, otherwise the previous one (Fri/Sat → Thu). */
export function prevDseTradingDay(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  let t = d.getTime();
  while (new Date(t).getUTCDay() > 4) t -= MS_PER_DAY;
  return toYmd(new Date(t));
}

/**
 * The date `sessions` trading days after `ymd`.
 *
 * The anchor day is **not** counted: today's session is already reflected in
 * today's price, so "3 sessions out" means the third *future* session. A
 * non-positive count collapses to the next tradeable day.
 */
export function addDseTradingDays(ymd: string, sessions: number): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  if (!Number.isFinite(sessions) || sessions <= 0) return nextDseTradingDay(ymd);
  let t = d.getTime();
  let left = Math.round(sessions);
  while (left > 0) {
    t += MS_PER_DAY;
    if (new Date(t).getUTCDay() <= 4) left -= 1;
  }
  return toYmd(new Date(t));
}

/**
 * Whole calendar days from `fromYmd` to `toYmd` — negative when `toYmd` is in
 * the past. Counts every day, not sessions: a record date lands on a calendar
 * date regardless of whether the exchange is open.
 *
 * Null when either string is not a valid `YYYY-MM-DD`.
 */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number | null {
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** The later of two `YYYY-MM-DD` strings; lexicographic order is chronological. */
export function laterYmd(a: string, b: string | null | undefined): string {
  if (!b || !parseYmd(b)) return a;
  if (!parseYmd(a)) return b;
  return b > a ? b : a;
}

/** `9 Aug` — with the year appended only when asked for. */
export function formatDseDate(ymd: string, withYear = false): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  return withYear ? `${day} ${month} ${d.getUTCFullYear()}` : `${day} ${month}`;
}

/**
 * A compact, unambiguous date range for the UI:
 *
 *   • same month      → `9–14 Aug`
 *   • same year       → `28 Aug – 3 Sep`
 *   • across new year → `28 Dec 2026 – 3 Jan 2027`
 *   • single day      → `14 Aug`
 */
export function formatDseDateRange(minYmd: string, maxYmd: string): string {
  const a = parseYmd(minYmd);
  const b = parseYmd(maxYmd);
  if (!a || !b) return minYmd === maxYmd ? minYmd : `${minYmd} – ${maxYmd}`;
  if (minYmd === maxYmd) return formatDseDate(minYmd);

  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  if (!sameYear) {
    return `${formatDseDate(minYmd, true)} – ${formatDseDate(maxYmd, true)}`;
  }
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${formatDseDate(maxYmd)}`;
  }
  return `${formatDseDate(minYmd)} – ${formatDseDate(maxYmd)}`;
}
