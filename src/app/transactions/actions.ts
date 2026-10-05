"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import type { FormState } from "@/components/ui/server-form";
import { computeTradeCommissionBdt } from "@/lib/fees/trade-commission";
import { loadCorporateActions } from "@/lib/data";
import { formatBdt } from "@/lib/format-bdt";
import { appendJournalEntry, isJournalHorizon, parseTags } from "@/lib/journal";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { sharesAvailableForSymbol, type TransactionRow } from "@/lib/portfolio";
import { withBonusShares } from "@/lib/portfolio-view";
import { normalizeSymbol } from "@/lib/symbol";
import { appendTransaction, loadTransactions } from "@/lib/transactions";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A trade dated `ymd` is stamped 11:00 Dhaka; one dated today keeps the real time. */
function tradeInstant(ymd: string, now: Date): string {
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  if (!ymd || ymd === today) return now.toISOString();
  return new Date(`${ymd}T11:00:00+06:00`).toISOString();
}

export async function recordTransaction(_prev: FormState, formData: FormData): Promise<FormState> {
  const symbol = normalizeSymbol(formData.get("symbol"));
  const side = String(formData.get("side") ?? "").toLowerCase();
  const quantity = Number(String(formData.get("quantity") ?? "").trim());
  const price = Number(String(formData.get("price_per_share") ?? "").trim());
  const feesRaw = String(formData.get("fees_bdt") ?? "").trim();
  const ymd = String(formData.get("trade_date") ?? "").trim();
  const thesis = String(formData.get("thesis") ?? "").trim();
  const horizon = String(formData.get("horizon") ?? "").trim();
  const exitCondition = String(formData.get("exit_condition") ?? "").trim();
  const tags = parseTags(String(formData.get("tags") ?? ""));

  if (!symbol) return { error: "Symbol is required." };
  if (side !== "buy" && side !== "sell") return { error: "Side must be buy or sell." };
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: "Quantity must be a positive number." };
  if (!Number.isFinite(price) || price < 0) return { error: "Price must be zero or greater." };
  if (ymd && !YMD.test(ymd)) return { error: "Date must be YYYY-MM-DD." };
  const wantsJournal = thesis !== "" || exitCondition !== "" || tags.length > 0;
  if (wantsJournal && !thesis) return { error: "Write why you made the trade, or leave the journal fields blank." };
  if (wantsJournal && !isJournalHorizon(horizon)) return { error: "Pick a horizon for the journal entry." };

  const fees = feesRaw === "" ? computeTradeCommissionBdt(quantity, price) : Number(feesRaw);
  if (!Number.isFinite(fees) || fees < 0) return { error: "Fees must be zero or greater." };

  const [rows, actions] = await Promise.all([loadTransactions(), loadCorporateActions()]);
  if (side === "sell") {
    // Bonus shares already credited can be sold too.
    const available = sharesAvailableForSymbol(withBonusShares(rows, actions, dhakaToday()), symbol);
    if (quantity > available) {
      return { error: `Cannot sell ${quantity} ${symbol}; you hold ${available}.` };
    }
  }

  const row: TransactionRow = {
    id: randomUUID(),
    created_at: tradeInstant(ymd, new Date()),
    symbol,
    side,
    quantity,
    price_per_share: price,
    category: null,
    fees_bdt: Math.round(fees * 100) / 100,
    account_type: "long_term",
  };
  await appendTransaction(row);
  if (wantsJournal && isJournalHorizon(horizon)) {
    await appendJournalEntry({
      id: randomUUID(),
      transaction_id: row.id,
      created_at: row.created_at,
      thesis,
      horizon,
      exit_condition: exitCondition || null,
      tags,
    });
  }

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/history");
  revalidatePath("/journal");
  const noted = wantsJournal ? " Journal entry saved." : "";
  return { ok: `Recorded ${side} of ${quantity} ${symbol} at ${formatBdt(price)}.${noted}` };
}
