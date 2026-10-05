import type { JournalEntry, JournalHorizon } from "@/lib/data-types";
import type { TransactionRow } from "@/lib/portfolio";
import { readJson, writeJson } from "@/lib/store";
import { normalizeSymbol } from "@/lib/symbol";

export const JOURNAL_HORIZONS: readonly JournalHorizon[] = ["weeks", "months", "years"];

export function isJournalHorizon(value: string): value is JournalHorizon {
  return (JOURNAL_HORIZONS as readonly string[]).includes(value);
}

/** Comma-separated tags, trimmed, lower-cased, without blanks or repeats. */
export function parseTags(raw: string): string[] {
  const tags = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)];
}

/** Transaction id -> its entries, oldest first. */
export function journalByTransaction(entries: readonly JournalEntry[]): Map<string, JournalEntry[]> {
  const out = new Map<string, JournalEntry[]>();
  for (const e of [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const list = out.get(e.transaction_id);
    if (list) list.push(e);
    else out.set(e.transaction_id, [e]);
  }
  return out;
}

/** Entries whose trade is in `symbol`. Entries for a trade not in the ledger are left out. */
export function journalForSymbol(
  entries: readonly JournalEntry[],
  transactions: readonly TransactionRow[],
  symbol: string,
): JournalEntry[] {
  const sym = normalizeSymbol(symbol);
  const ids = new Set(transactions.filter((t) => normalizeSymbol(t.symbol) === sym).map((t) => t.id));
  return entries.filter((e) => ids.has(e.transaction_id));
}

/** Newest first. */
export async function loadJournal(): Promise<JournalEntry[]> {
  const rows = await readJson<JournalEntry[]>("journal", []);
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export async function appendJournalEntry(entry: JournalEntry): Promise<void> {
  const rows = await readJson<JournalEntry[]>("journal", []);
  rows.push(entry);
  await writeJson("journal", rows);
}
