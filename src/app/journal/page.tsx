import { loadJournal } from "@/lib/journal";
import { loadTransactions } from "@/lib/transactions";
import { JournalView, type JournalRow } from "./view";

export const dynamic = "force-dynamic";

export default async function JournalPage() {
  const [entries, transactions] = await Promise.all([loadJournal(), loadTransactions()]);
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const rows: JournalRow[] = entries.map((e) => {
    const t = byId.get(e.transaction_id);
    return {
      ...e,
      trade: t ? { symbol: t.symbol, side: t.side, quantity: Number(t.quantity), price: Number(t.price_per_share) } : null,
    };
  });
  return <JournalView rows={rows} />;
}
