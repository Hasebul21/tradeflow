import { ErrorState } from "@/components/ui/states";
import { attributionAsOf } from "@/lib/market-views";
import { loadSectorIndexBars } from "@/lib/market/sector-index";
import { barRange, buildPortfolioView, loadPortfolioData, resolveViewAsOf } from "@/lib/portfolio-view";
import { Dashboard } from "./dashboard";

export const dynamic = "force-dynamic";

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const { as_of } = await searchParams;
  const [data, sectorBars] = await Promise.all([loadPortfolioData(), loadSectorIndexBars()]);
  const asOf = resolveViewAsOf(data, as_of);
  if (!asOf.ok) return <ErrorState title="No prices for that date" message={asOf.error} />;
  return (
    <Dashboard
      view={buildPortfolioView(data, asOf.asOf)}
      attribution={attributionAsOf(data, sectorBars, asOf.asOf, 5)}
      asOf={asOf.asOf}
      range={barRange(data.bars)}
    />
  );
}
