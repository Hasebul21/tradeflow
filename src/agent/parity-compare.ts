// The comparison behind `npm run parity`: local() rows against the rows Zetaris returned, on the SQL's columns only.
// It lives here, and not in scripts/parity.ts, so a test can prove that it catches a difference.
import type { NamedQuery, Row } from "./queries";

/** change_pct is rounded to two places on both sides, which can differ by one in the last place. */
const tolerance = (column: string) => (column === "change_pct" ? 0.011 : 1e-6);

export function sameValue(column: string, numeric: boolean, a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (numeric && typeof x === "number" && typeof y === "number") return Math.abs(x - y) <= tolerance(column);
  return x === y;
}

/**
 * The differences between local() and the rows Zetaris returned, on `sqlColumns` only. An empty list means a
 * match. Two empty sides are a difference too: nothing was compared. So is a repeated key on either side.
 */
export function differences(q: NamedQuery, local: Row[], remote: Row[]): string[] {
  const key = q.sqlKey;
  const columns = q.sqlColumns;
  if (!key || !columns) return ["the query has no sqlKey or sqlColumns"];
  const numeric = new Set(q.sqlNumeric);
  const out: string[] = [];

  const project = (side: string, rows: Row[]) => {
    const byKey = new Map<string, Row>();
    for (const row of rows) {
      const k = key(row);
      if (k === null) continue;
      if (byKey.has(k)) out.push(`${k}: appears more than once in ${side}`);
      byKey.set(k, Object.fromEntries(columns.map((c) => [c, row[c]])));
    }
    return byKey;
  };
  const mine = project("local()", local);
  const theirs = project("Zetaris", remote);

  if (mine.size === 0 && theirs.size === 0) return [...out, "no rows on either side, so nothing was compared"];
  for (const k of mine.keys()) if (!theirs.has(k)) out.push(`${k}: in local() but not in Zetaris`);
  for (const k of theirs.keys()) if (!mine.has(k)) out.push(`${k}: in Zetaris but not in local()`);
  for (const [k, row] of mine) {
    const other = theirs.get(k);
    if (!other) continue;
    for (const c of columns) {
      if (!sameValue(c, numeric.has(c), row[c], other[c])) out.push(`${k}.${c}: local ${JSON.stringify(row[c])}, Zetaris ${JSON.stringify(other[c])}`);
    }
  }
  return out;
}
