import { ErrorState } from "@/components/ui/states";
import { barRange, buildPortfolioView, loadPortfolioData, resolveViewAsOf } from "@/lib/portfolio-view";
import { positionWeights, sectorWeights } from "@/lib/rules";
import { sectorMatchKey } from "@/lib/sector-targets";
import { RulesView } from "./view";

export const dynamic = "force-dynamic";

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const { as_of } = await searchParams;
  const data = await loadPortfolioData();
  const asOf = resolveViewAsOf(data, as_of);
  if (!asOf.ok) return <ErrorState title="No prices for that date" message={asOf.error} />;
  const v = buildPortfolioView(data, asOf.asOf);
  const bySector = sectorWeights(positionWeights(v.holdings));
  const actualFor = (sector: string) => {
    for (const [label, w] of bySector) if (sectorMatchKey(label) === sectorMatchKey(sector)) return w;
    return 0;
  };
  // Plans are editable, so they always come from the current file, judged at the as-of prices.
  const lastClose = new Map<string, number>();
  for (const b of data.bars) if (b.bar_date <= asOf.asOf) lastClose.set(b.symbol, b.close);

  return (
    <RulesView
      asOf={asOf.asOf}
      range={barRange(data.bars)}
      findings={v.findings}
      rules={data.rules}
      sectors={v.rules.sector_targets.map((t) => ({ ...t, actual: actualFor(t.sector) }))}
      prices={Object.fromEntries(lastClose)}
    />
  );
}
