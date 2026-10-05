import { ErrorState } from "@/components/ui/states";
import { sectorMovesAsOf } from "@/lib/market-views";
import { loadSectorIndexBars } from "@/lib/market/sector-index";
import { barRange, loadPortfolioData, resolveViewAsOf } from "@/lib/portfolio-view";
import { SectorIndicesView } from "./view";

export const dynamic = "force-dynamic";

const WINDOWS = [5, 20, 60];

export default async function SectorIndicesPage({ searchParams }: { searchParams: Promise<{ as_of?: string; sessions?: string }> }) {
  const { as_of, sessions } = await searchParams;
  const [data, sectorBars] = await Promise.all([loadPortfolioData(), loadSectorIndexBars()]);
  const asOf = resolveViewAsOf(data, as_of);
  if (!asOf.ok) return <ErrorState title="No prices for that date" message={asOf.error} />;
  const n = WINDOWS.includes(Number(sessions)) ? Number(sessions) : 5;
  return <SectorIndicesView moves={sectorMovesAsOf(data, sectorBars, asOf.asOf, n)} windows={WINDOWS} range={barRange(data.bars)} />;
}
