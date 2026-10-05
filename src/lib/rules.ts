import type { Rules, SectorTarget, TradePlan } from "@/lib/data-types";
import { normalizeSectorLabel, sectorMatchKey } from "@/lib/sector-targets";

/** A holding's share of the portfolio by market value. */
export type PositionWeight = {
  symbol: string;
  sector: string;
  marketValue: number;
  weightPct: number;
};

export type RuleFinding =
  | {
      kind: "max_position_weight";
      symbol: string;
      weightPct: number;
      limitPct: number;
      message: string;
    }
  | {
      kind: "sector_target";
      sector: string;
      actualPct: number;
      targetPct: number;
      deltaPct: number;
      message: string;
    }
  | {
      kind: "trade_plan_reached";
      planId: string;
      symbol: string;
      side: "buy" | "sell";
      targetPrice: number;
      ltp: number;
      message: string;
    };

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Weights sum to 100 across the positions that have a market value. */
export function positionWeights(
  rows: ReadonlyArray<{ symbol: string; sector: string | null; marketValue: number | null }>,
): PositionWeight[] {
  const valued = rows.filter(
    (r): r is { symbol: string; sector: string | null; marketValue: number } =>
      r.marketValue !== null && Number.isFinite(r.marketValue) && r.marketValue > 0,
  );
  const total = valued.reduce((sum, r) => sum + r.marketValue, 0);
  return valued.map((r) => ({
    symbol: r.symbol,
    sector: normalizeSectorLabel(r.sector),
    marketValue: r.marketValue,
    weightPct: total > 0 ? (r.marketValue / total) * 100 : 0,
  }));
}

/** Sector label -> share of the portfolio, in percent. */
export function sectorWeights(weights: readonly PositionWeight[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of weights) {
    const label = normalizeSectorLabel(w.sector);
    out.set(label, (out.get(label) ?? 0) + w.weightPct);
  }
  return out;
}

export function checkMaxPositionWeight(
  weights: readonly PositionWeight[],
  limitPct: number,
): RuleFinding[] {
  if (!Number.isFinite(limitPct) || limitPct <= 0) return [];
  return weights
    .filter((w) => w.weightPct > limitPct)
    .sort((a, b) => b.weightPct - a.weightPct)
    .map((w) => ({
      kind: "max_position_weight" as const,
      symbol: w.symbol,
      weightPct: round1(w.weightPct),
      limitPct,
      message: `${w.symbol} is ${round1(w.weightPct)}% of the portfolio, above your ${limitPct}% limit.`,
    }));
}

/**
 * One finding per target sector that sits more than `tolerancePct` away from
 * its target, in either direction. Sectors with no target are not judged.
 */
export function checkSectorTargets(
  weights: readonly PositionWeight[],
  targets: readonly SectorTarget[],
  tolerancePct: number,
): RuleFinding[] {
  const actualByKey = new Map<string, number>();
  for (const [label, pct] of sectorWeights(weights)) actualByKey.set(sectorMatchKey(label), pct);

  const out: RuleFinding[] = [];
  for (const t of targets) {
    const label = normalizeSectorLabel(t.sector);
    const actual = actualByKey.get(sectorMatchKey(label)) ?? 0;
    const delta = actual - t.target_percent;
    if (Math.abs(delta) <= tolerancePct) continue;
    const direction = delta > 0 ? "above" : "below";
    out.push({
      kind: "sector_target",
      sector: label,
      actualPct: round1(actual),
      targetPct: t.target_percent,
      deltaPct: round1(delta),
      message: `${label} is ${round1(actual)}% of the portfolio, ${round1(Math.abs(delta))} points ${direction} your ${t.target_percent}% target.`,
    });
  }
  return out.sort((a, b) => Math.abs((b as { deltaPct: number }).deltaPct) - Math.abs((a as { deltaPct: number }).deltaPct));
}

/** A buy plan is reached when the price falls to its target; a sell plan when it rises to it. */
export function checkTradePlans(
  plans: readonly TradePlan[],
  ltpBySymbol: ReadonlyMap<string, number | null | undefined>,
): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const p of plans) {
    if (p.executed) continue;
    const ltp = ltpBySymbol.get(p.symbol.toUpperCase());
    if (ltp === null || ltp === undefined || !Number.isFinite(ltp)) continue;
    const reached = p.side === "buy" ? ltp <= p.target_price : ltp >= p.target_price;
    if (!reached) continue;
    out.push({
      kind: "trade_plan_reached",
      planId: p.id,
      symbol: p.symbol,
      side: p.side,
      targetPrice: p.target_price,
      ltp,
      message: `${p.symbol} is at ${ltp.toFixed(2)}, past your ${p.side} target of ${p.target_price.toFixed(2)}.`,
    });
  }
  return out;
}

export function evaluateRules(args: {
  rows: ReadonlyArray<{ symbol: string; sector: string | null; marketValue: number | null }>;
  ltpBySymbol: ReadonlyMap<string, number | null | undefined>;
  rules: Rules;
}): RuleFinding[] {
  const weights = positionWeights(args.rows);
  return [
    ...checkMaxPositionWeight(weights, args.rules.max_position_weight_pct),
    ...checkSectorTargets(weights, args.rules.sector_targets, args.rules.sector_tolerance_pct),
    ...checkTradePlans(args.rules.trade_plans, args.ltpBySymbol),
  ];
}
