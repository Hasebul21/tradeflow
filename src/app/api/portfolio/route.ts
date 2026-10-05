import { NextResponse, type NextRequest } from "next/server";
import { dataFromRequest } from "@/lib/http";
import { buildPortfolioView } from "@/lib/portfolio-view";

export const dynamic = "force-dynamic";

/** The portfolio page as JSON, for scripts and tools. `?as_of=YYYY-MM-DD` for a past session. */
export async function GET(request: NextRequest) {
  const r = await dataFromRequest(request);
  if (!r.ok) return r.response;
  return NextResponse.json(buildPortfolioView(r.value.data, r.value.asOf));
}
