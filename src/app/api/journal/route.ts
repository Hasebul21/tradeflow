import { NextResponse, type NextRequest } from "next/server";
import { journalForSymbol, loadJournal } from "@/lib/journal";
import { loadTransactions } from "@/lib/transactions";

export const dynamic = "force-dynamic";

/** Journal entries, newest first. `?symbol=` keeps the entries for that symbol's trades. */
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol")?.trim();
  const entries = await loadJournal();
  if (!symbol) return NextResponse.json(entries);
  return NextResponse.json(journalForSymbol(entries, await loadTransactions(), symbol));
}
