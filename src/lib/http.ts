import { NextResponse, type NextRequest } from "next/server";
import { loadPortfolioData, resolveViewAsOf, type PortfolioData } from "@/lib/portfolio-view";

export type Resolved<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/** Loads the data and resolves `?as_of=`, or a 400 that says what is wrong with the date. */
export async function dataFromRequest(request: NextRequest): Promise<Resolved<{ data: PortfolioData; asOf: string }>> {
  const data = await loadPortfolioData();
  const asOf = resolveViewAsOf(data, request.nextUrl.searchParams.get("as_of")?.trim() || null);
  if (!asOf.ok) return { ok: false, response: badRequest(asOf.error) };
  return { ok: true, value: { data, asOf: asOf.asOf } };
}

/** `?sessions=`: a whole number from 1 to `max`, or the default when absent. */
export function sessionsFromRequest(request: NextRequest, fallback: number, max = 120): Resolved<number> {
  const raw = request.nextUrl.searchParams.get("sessions")?.trim();
  if (!raw) return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { ok: false, response: badRequest(`sessions must be a whole number from 1 to ${max}.`) };
  }
  return { ok: true, value: n };
}
