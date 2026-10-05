"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import type { FormState } from "@/components/ui/server-form";
import { appendContribution } from "@/lib/data";
import { formatBdt } from "@/lib/format-bdt";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function addContribution(_prev: FormState, formData: FormData): Promise<FormState> {
  const amount = Number(String(formData.get("amount_bdt") ?? "").trim());
  const ymd = String(formData.get("date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Amount must be above zero." };
  if (ymd && !YMD.test(ymd)) return { error: "Date must be YYYY-MM-DD." };

  await appendContribution({
    id: randomUUID(),
    created_at: ymd ? new Date(`${ymd}T11:00:00+06:00`).toISOString() : new Date().toISOString(),
    amount_bdt: Math.round(amount * 100) / 100,
    note: note || null,
  });
  revalidatePath("/invested");
  return { ok: `Added ${formatBdt(amount)}.` };
}
