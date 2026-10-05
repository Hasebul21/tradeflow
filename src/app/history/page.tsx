import { loadCorporateActions } from "@/lib/data";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { realizedPnlByTransaction, totalRealizedProfitLossBdt } from "@/lib/portfolio";
import { loadPortfolioView, withBonusShares } from "@/lib/portfolio-view";
import { loadTransactions, sortTransactionsByLatest } from "@/lib/transactions";
import { HistoryView, type SellRow } from "./view";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [ledger, actions, v] = await Promise.all([loadTransactions(), loadCorporateActions(), loadPortfolioView()]);
  // Bonus shares lower the average cost, so a later sell is measured against it.
  const rows = withBonusShares(ledger, actions, v.asOf ?? dhakaToday());
  const byId = realizedPnlByTransaction(rows);
  const sells: SellRow[] = sortTransactionsByLatest(rows.filter((r) => r.side === "sell")).map((t) => ({
    id: t.id,
    created_at: t.created_at,
    symbol: t.symbol,
    account_type: t.account_type ?? "long_term",
    quantity: Number(t.quantity),
    price: Number(t.price_per_share),
    fees: Number(t.fees_bdt ?? 0),
    avgCost: byId.get(t.id)?.avgCost ?? null,
    pnl: byId.get(t.id)?.pnl ?? null,
  }));
  return (
    <HistoryView
      asOf={v.asOf}
      sells={sells}
      realized={totalRealizedProfitLossBdt(rows)}
      dividends={[...v.dividends].reverse()}
      dividendIncome={v.dividendIncomeBdt}
      bonus={v.bonusShares}
    />
  );
}
