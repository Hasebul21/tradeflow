import { ErrorState } from "@/components/ui/states";
import { loadFundamentals } from "@/lib/fundamentals";
import { instrumentRows } from "@/lib/instrument-view";
import { barRange, loadPortfolioData, resolveViewAsOf } from "@/lib/portfolio-view";
import { InstrumentsView } from "./view";

export const dynamic = "force-dynamic";

export default async function InstrumentsPage({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const { as_of } = await searchParams;
  const [data, fundamentals] = await Promise.all([loadPortfolioData(), loadFundamentals()]);
  const asOf = resolveViewAsOf(data, as_of);
  if (!asOf.ok) return <ErrorState title="No prices for that date" message={asOf.error} />;
  return <InstrumentsView rows={instrumentRows(data, fundamentals, asOf.asOf)} asOf={asOf.asOf} range={barRange(data.bars)} />;
}
