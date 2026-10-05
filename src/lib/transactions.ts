import type { TransactionRow } from "@/lib/portfolio";
import { readJson, writeJson } from "@/lib/store";

/** Oldest first, then id, which is the order the ledger maths expects. */
export function sortTransactionsChronological(rows: readonly TransactionRow[]): TransactionRow[] {
  return [...rows].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}

/** Newest first (then id for a stable tie-break). */
export function sortTransactionsByLatest(rows: readonly TransactionRow[]): TransactionRow[] {
  return [...rows].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}

export function filterTransactionsLastNDays(
  rows: readonly TransactionRow[],
  days: number,
  now: Date = new Date(),
): TransactionRow[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return sortTransactionsByLatest(rows.filter((r) => new Date(r.created_at).getTime() >= cutoff));
}

export async function loadTransactions(): Promise<TransactionRow[]> {
  const rows = await readJson<TransactionRow[]>("transactions", []);
  return sortTransactionsChronological(rows);
}

export async function appendTransaction(row: TransactionRow): Promise<void> {
  const rows = await readJson<TransactionRow[]>("transactions", []);
  rows.push(row);
  await writeJson("transactions", sortTransactionsChronological(rows));
}
