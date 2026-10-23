import { NextResponse, type NextRequest } from "next/server";
import { RUN_ID_PATTERN } from "@/agent/orchestrator";
import { cancel } from "@/agent/registry";
import { RUN_ID_MESSAGE } from "@/agent/trace-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (status: number, type: string, message: string) =>
  NextResponse.json({ status: "error", error: { type, message, recoverable: false } }, { status });

/**
 * Stops a running run: { run_id, cancelled: true }. The run ends needs_human with stop_reason "cancelled" and its usage
 * so far. 400 for a run id that fails the same check as GET /run/<run_id>, 404 "NotRunning" for an id that is not
 * running (never started, or already finished). Only the registry is touched: no file is read or written here.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ run_id: string }> }) {
  const { run_id: runId } = await params;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return error(400, "InvalidInput", RUN_ID_MESSAGE);
  if (!cancel(runId)) return error(404, "NotRunning", `Run ${runId} is not running.`);
  return NextResponse.json({ run_id: runId, cancelled: true });
}
