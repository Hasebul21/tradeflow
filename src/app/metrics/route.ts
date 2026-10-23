import { NextResponse, type NextRequest } from "next/server";
import { metricsPayload, readRuns, runLimit } from "@/agent/metrics";

// logs/ is read on each request, never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Metrics across the newest runs in logs/: the runs read, the newest and oldest line timestamps, and the numbers for
 * all runs ("all") and for each task. ?limit= is a whole number from 1 to 1000; the default is 200.
 */
export async function GET(request: NextRequest) {
  const limit = runLimit(request.nextUrl.searchParams.get("limit"));
  return NextResponse.json(metricsPayload(await readRuns("logs", limit)));
}
