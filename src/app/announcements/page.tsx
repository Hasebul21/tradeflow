import { filterAnnouncements, loadAnnouncements } from "@/lib/announcements";
import { aggregateHoldings } from "@/lib/portfolio";
import { normalizeSymbol } from "@/lib/symbol";
import { loadTransactions } from "@/lib/transactions";
import { AnnouncementsView } from "./view";

export const dynamic = "force-dynamic";

type Search = Promise<{ holdings?: string; symbol?: string }>;

export default async function AnnouncementsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const mineOnly = params.holdings === "1";
  const symbol = normalizeSymbol(params.symbol);
  const [all, transactions] = await Promise.all([loadAnnouncements(), loadTransactions()]);
  const held = aggregateHoldings(transactions).map((h) => h.symbol);
  const rows = filterAnnouncements(all, { symbols: symbol ? [symbol] : mineOnly ? held : [] });
  const symbols = [...new Set(all.map((a) => a.symbol))].sort();
  return <AnnouncementsView rows={rows} total={all.length} mineOnly={mineOnly} symbol={symbol} symbols={symbols} />;
}
