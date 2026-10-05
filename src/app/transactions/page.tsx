import { loadBars, loadInstruments } from "@/lib/data";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { barRange } from "@/lib/portfolio-view";
import { loadTransactions, sortTransactionsByLatest } from "@/lib/transactions";
import { TransactionsView } from "./view";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const [rows, instruments, bars] = await Promise.all([loadTransactions(), loadInstruments(), loadBars()]);
  return (
    <TransactionsView
      rows={sortTransactionsByLatest(rows)}
      instruments={[...instruments.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))}
      today={dhakaToday()}
      lastSession={barRange(bars)?.last ?? null}
    />
  );
}
