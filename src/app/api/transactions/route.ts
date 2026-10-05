import { NextResponse, type NextRequest } from "next/server";
import { dataFromRequest } from "@/lib/http";
import { dataUpTo } from "@/lib/portfolio-view";
import { loadTransactions } from "@/lib/transactions";

export const dynamic = "force-dynamic";

/** The ledger, oldest first. `?as_of=YYYY-MM-DD` leaves out later trades. */
export async function GET(request: NextRequest) {
  if (!request.nextUrl.searchParams.get("as_of")) return NextResponse.json(await loadTransactions());
  const r = await dataFromRequest(request);
  if (!r.ok) return r.response;
  return NextResponse.json(dataUpTo(r.value.data, r.value.asOf).transactions);
}
