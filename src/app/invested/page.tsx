import { loadContributions } from "@/lib/data";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { loadPortfolioView } from "@/lib/portfolio-view";
import { InvestedView } from "./view";

export const dynamic = "force-dynamic";

export default async function InvestedPage() {
  const [contributions, v] = await Promise.all([loadContributions(), loadPortfolioView()]);
  return (
    <InvestedView
      asOf={v.asOf}
      rows={[...contributions].reverse()}
      deposited={v.totalContributions}
      inPositions={v.summary.totalInvested}
      marketValue={v.totalMarketValue}
      gain={v.totalMarketValue + v.summary.realizedGainLoss - v.summary.totalInvested}
      today={dhakaToday()}
    />
  );
}
