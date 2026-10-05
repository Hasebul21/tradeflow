import { NextResponse, type NextRequest } from "next/server";
import { filterAnnouncements, loadAnnouncements } from "@/lib/announcements";
import { parseYmd } from "@/lib/market/trading-calendar";

export const dynamic = "force-dynamic";

/**
 * Announcements, newest first. Optional `symbol`, and `from` / `to` as
 * YYYY-MM-DD in Dhaka time. `as_of` is the same as `to`.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = params.get("symbol")?.trim() ?? "";
  const from = params.get("from")?.trim() || null;
  const to = params.get("to")?.trim() || params.get("as_of")?.trim() || null;
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value && !parseYmd(value)) {
      return NextResponse.json({ error: `${name} must be YYYY-MM-DD.` }, { status: 400 });
    }
  }
  const rows = filterAnnouncements(await loadAnnouncements(), { symbols: symbol ? [symbol] : [], from, to });
  return NextResponse.json(rows);
}
