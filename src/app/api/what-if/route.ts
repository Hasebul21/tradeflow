import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "@/lib/http";
import { loadPortfolioData, resolveViewAsOf } from "@/lib/portfolio-view";
import { previewTrade } from "@/lib/what-if";

export const dynamic = "force-dynamic";

/**
 * Preview a trade without saving it. Body: `{ symbol, side, quantity, price?, as_of? }`.
 * The price defaults to the last close on the as-of date.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("The body must be JSON.");
  }
  if (!body || typeof body !== "object") return badRequest("The body must be a JSON object.");
  const data = await loadPortfolioData();
  const asOf = resolveViewAsOf(data, typeof body.as_of === "string" && body.as_of ? body.as_of : null);
  if (!asOf.ok) return badRequest(asOf.error);
  const price = body.price === undefined || body.price === null || body.price === "" ? null : Number(body.price);
  const result = previewTrade(data, asOf.asOf, {
    symbol: String(body.symbol ?? ""),
    side: String(body.side ?? "").toLowerCase() as "buy" | "sell",
    quantity: Number(body.quantity),
    price,
  });
  return result.ok ? NextResponse.json(result) : badRequest(result.error);
}
