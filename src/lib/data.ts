import type { Contribution, CorporateAction, DailyBar, IndexBar, Instrument, Rules } from "@/lib/data-types";
import { readJson, writeJson } from "@/lib/store";

export const EMPTY_RULES: Rules = {
  max_position_weight_pct: 25,
  sector_tolerance_pct: 5,
  sector_targets: [],
  trade_plans: [],
};

export async function loadBars(): Promise<DailyBar[]> {
  return readJson<DailyBar[]>("bars", []);
}

export async function loadInstruments(): Promise<Map<string, Instrument>> {
  const rows = await readJson<Instrument[]>("instruments", []);
  return new Map(rows.map((r) => [r.symbol.toUpperCase(), r]));
}

export async function loadContributions(): Promise<Contribution[]> {
  const rows = await readJson<Contribution[]>("contributions", []);
  return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function appendContribution(row: Contribution): Promise<void> {
  const rows = await readJson<Contribution[]>("contributions", []);
  rows.push(row);
  await writeJson("contributions", rows);
}

export async function loadRules(): Promise<Rules> {
  const rules = await readJson<Rules>("rules", EMPTY_RULES);
  return { ...EMPTY_RULES, ...rules };
}

export async function saveRules(rules: Rules): Promise<void> {
  await writeJson("rules", rules);
}

export async function loadCorporateActions(): Promise<CorporateAction[]> {
  const rows = await readJson<CorporateAction[]>("corporate_actions", []);
  return [...rows].sort((a, b) => a.record_date.localeCompare(b.record_date) || a.id.localeCompare(b.id));
}

export async function loadIndexBars(): Promise<IndexBar[]> {
  const rows = await readJson<IndexBar[]>("index_bars", []);
  return [...rows].sort((a, b) => a.bar_date.localeCompare(b.bar_date));
}
