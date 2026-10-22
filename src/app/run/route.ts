import { NextResponse, type NextRequest } from "next/server";
import { httpStatusOf, runRequest } from "@/agent/request";

// Next 16: segment config `dynamic` is still valid (cacheComponents is off) and matches the other routes.
export const dynamic = "force-dynamic";
// The agents read and write files (memory, logs/), so this never runs on the edge.
export const runtime = "nodejs";

/**
 * Runs one task. Body: `{ run_id?, input: { task?, question?, as_of?, ... }, options?: { sample_mode? } }`.
 * Returns the orchestrator result: 200 for success or needs_human, 400 for InvalidInput, 500 for any other error.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const result = await runRequest(body);
  return NextResponse.json(result, { status: httpStatusOf(result) });
}
