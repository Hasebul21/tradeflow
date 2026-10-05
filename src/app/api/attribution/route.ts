import { NextResponse, type NextRequest } from "next/server";
import { dataFromRequest, sessionsFromRequest } from "@/lib/http";
import { attributionAsOf } from "@/lib/market-views";
import { loadSectorIndexBars } from "@/lib/market/sector-index";

export const dynamic = "force-dynamic";

/** What moved the portfolio over `sessions` (default 5) ending `as_of` (default the latest session). */
export async function GET(request: NextRequest) {
  const r = await dataFromRequest(request);
  if (!r.ok) return r.response;
  const sessions = sessionsFromRequest(request, 5);
  if (!sessions.ok) return sessions.response;
  const sectorBars = await loadSectorIndexBars();
  return NextResponse.json({ asOf: r.value.asOf, ...attributionAsOf(r.value.data, sectorBars, r.value.asOf, sessions.value) });
}
