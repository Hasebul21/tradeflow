import { ErrorState } from "@/components/ui/states";
import { loadAnnouncements } from "@/lib/announcements";
import { loadFundamentals } from "@/lib/fundamentals";
import { instrumentView } from "@/lib/instrument-view";
import { loadJournal } from "@/lib/journal";
import { loadSectorIndexBars } from "@/lib/market/sector-index";
import { barRange, loadPortfolioData, resolveViewAsOf } from "@/lib/portfolio-view";
import { InstrumentPanel } from "./view";

export const dynamic = "force-dynamic";

export default async function InstrumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ as_of?: string }>;
}) {
  const [{ symbol }, { as_of }] = await Promise.all([params, searchParams]);
  const [data, fundamentals, sectorBars, announcements, journal] = await Promise.all([
    loadPortfolioData(),
    loadFundamentals(),
    loadSectorIndexBars(),
    loadAnnouncements(),
    loadJournal(),
  ]);
  const asOf = resolveViewAsOf(data, as_of);
  if (!asOf.ok) return <ErrorState title="No prices for that date" message={asOf.error} />;
  const view = instrumentView({ data, symbol: decodeURIComponent(symbol), asOf: asOf.asOf, fundamentals, sectorBars, announcements, journal });
  if (!view) return <ErrorState title="Unknown symbol" message={`There is no instrument called ${decodeURIComponent(symbol)} in the data.`} />;
  return <InstrumentPanel v={view} range={barRange(data.bars)} />;
}
