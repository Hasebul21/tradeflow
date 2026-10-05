"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import type { FormState } from "@/components/ui/server-form";
import { loadRules, saveRules } from "@/lib/data";
import { normalizeSymbol } from "@/lib/symbol";

function refresh() {
  revalidatePath("/");
  revalidatePath("/rules");
}

export async function saveLimits(_prev: FormState, formData: FormData): Promise<FormState> {
  const maxWeight = Number(String(formData.get("max_position_weight_pct") ?? "").trim());
  const tolerance = Number(String(formData.get("sector_tolerance_pct") ?? "").trim());
  if (!Number.isFinite(maxWeight) || maxWeight <= 0 || maxWeight > 100) {
    return { error: "Position limit must be between 1 and 100." };
  }
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) {
    return { error: "Sector tolerance must be between 0 and 100." };
  }
  const rules = await loadRules();
  await saveRules({ ...rules, max_position_weight_pct: maxWeight, sector_tolerance_pct: tolerance });
  refresh();
  return { ok: "Limits saved." };
}

export async function addTradePlan(_prev: FormState, formData: FormData): Promise<FormState> {
  const symbol = normalizeSymbol(formData.get("symbol"));
  const side = String(formData.get("side") ?? "").toLowerCase();
  const target = Number(String(formData.get("target_price") ?? "").trim());
  const qtyRaw = String(formData.get("quantity_shares") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!symbol) return { error: "Symbol is required." };
  if (side !== "buy" && side !== "sell") return { error: "Side must be buy or sell." };
  if (!Number.isFinite(target) || target <= 0) return { error: "Target price must be above zero." };
  const quantity = qtyRaw === "" ? null : Number(qtyRaw);
  if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) {
    return { error: "Shares must be a positive number, or blank." };
  }

  const rules = await loadRules();
  rules.trade_plans.push({
    id: randomUUID(),
    created_at: new Date().toISOString(),
    symbol,
    side,
    target_price: target,
    quantity_shares: quantity,
    note: note || null,
    executed: false,
  });
  await saveRules(rules);
  refresh();
  return { ok: `Plan added: ${side} ${symbol} at ${target}.` };
}

export async function removeTradePlan(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const rules = await loadRules();
  rules.trade_plans = rules.trade_plans.filter((p) => p.id !== id);
  await saveRules(rules);
  refresh();
}
