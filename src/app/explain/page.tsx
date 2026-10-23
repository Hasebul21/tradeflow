import { loadConfig } from "@/agent/config";
import { ErrorState } from "@/components/ui/states";
import { barRange, loadPortfolioData } from "@/lib/portfolio-view";
import { loadJournal } from "@/lib/journal";
import { ExplainView } from "./view";

export const dynamic = "force-dynamic";

const WORDS = 12;
/** True when the sample model answers; false when SAMPLE_MODE=false makes the config throw for want of keys. */
function sampleModeOn(): boolean {
  try {
    return loadConfig(process.env, () => {}).sampleMode;
  } catch {
    return false;
  }
}

const fewWords = (text: string) => {
  const words = text.trim().split(/\s+/);
  return words.length <= WORDS ? words.join(" ") : `${words.slice(0, WORDS).join(" ")}...`;
};

export default async function ExplainPage() {
  const data = await loadPortfolioData();
  const range = barRange(data.bars);
  if (range === null) return <ErrorState title="No prices" message="There are no price bars in the data." />;
  const journal = await loadJournal();
  const plans = data.rules.trade_plans
    .filter((p) => !p.executed && p.quantity_shares !== null && p.quantity_shares > 0)
    .map((p) => ({ id: p.id, label: `${p.id}: ${p.side} ${p.quantity_shares} ${p.symbol} at ${p.target_price}` }));
  return (
    <ExplainView
      range={range}
      theses={Object.fromEntries(journal.map((j) => [j.id, fewWords(j.thesis)]))}
      plans={plans}
      sampleMode={sampleModeOn()}
    />
  );
}
