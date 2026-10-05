/**
 * A timestamp as the reader's wall clock: `12 Aug, 9:00 pm` in Asia/Dhaka.
 *
 * For the small "Updated …" lines on /short-term and /long-term. Deliberately
 * short — no year, no seconds — because the line answers "is this list fresh?",
 * not "when exactly did the pipeline write this row"; the run tables and
 * Workflow monitoring carry the precise record. Rendered on the server only, so
 * SSR and hydration cannot disagree about it.
 *
 * Returns null for a missing or unparseable input rather than printing
 * "Invalid Date" into the page.
 */
export function formatDhakaDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
