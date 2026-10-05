import { NextResponse, type NextRequest } from "next/server";
import { loadFundamentals, summariseFundamentals } from "@/lib/fundamentals";
import { dataFromRequest } from "@/lib/http";
import { barsBySymbol, latestQuote } from "@/lib/market/quotes";
import { dataUpTo } from "@/lib/portfolio-view";
import { normalizeSymbol } from "@/lib/symbol";

export const dynamic = "force-dynamic";

/** Reported quarters, quarter-on-quarter change and trailing P/E as of a date. `?symbol=` for one company. */
export async function GET(request: NextRequest) {
  const r = await dataFromRequest(request);
  if (!r.ok) return r.response;
  const { data, asOf } = r.value;
  const rows = await loadFundamentals();
  const wanted = normalizeSymbol(request.nextUrl.searchParams.get("symbol"));
  const symbols = wanted ? [wanted] : [...new Set(rows.map((f) => normalizeSymbol(f.symbol)))].sort();
  if (wanted && !data.instruments.has(wanted)) {
    return NextResponse.json({ error: `Unknown symbol ${wanted}.` }, { status: 404 });
  }
  const grouped = barsBySymbol(dataUpTo(data, asOf).bars);
  return NextResponse.json({
    asOf,
    companies: symbols.map((s) => summariseFundamentals(rows, s, asOf, latestQuote(grouped.get(s) ?? [])?.ltp ?? null)),
  });
}
