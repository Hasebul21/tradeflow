import { NextResponse } from "next/server";
import { loadContributions } from "@/lib/data";
import { reconcile } from "@/lib/reconcile";
import { loadBankDeposits, loadBrokerStatement } from "@/lib/sources";
import { loadTransactions } from "@/lib/transactions";

export const dynamic = "force-dynamic";

/** The broker statement against the ledger, and the bank deposits against contributions. Read-only. */
export async function GET() {
  const [broker, ledger, bank, contributions] = await Promise.all([
    loadBrokerStatement(),
    loadTransactions(),
    loadBankDeposits(),
    loadContributions(),
  ]);
  return NextResponse.json(reconcile({ broker, ledger, bank, contributions }));
}
