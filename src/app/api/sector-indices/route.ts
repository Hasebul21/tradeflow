import { NextResponse, type NextRequest } from "next/server";
import { dataFromRequest, sessionsFromRequest } from "@/lib/http";
import { sectorMovesAsOf } from "@/lib/market-views";
import { loadSectorIndexBars } from "@/lib/market/sector-index";

export const dynamic = "force-dynamic";

/** Each sector index and DSEX over `sessions` (default 5) ending `as_of`. */
export async function GET(request: NextRequest) {
  const r = await dataFromRequest(request);
  if (!r.ok) return r.response;
  const sessions = sessionsFromRequest(request, 5);
  if (!sessions.ok) return sessions.response;
  return NextResponse.json(sectorMovesAsOf(r.value.data, await loadSectorIndexBars(), r.value.asOf, sessions.value));
}
