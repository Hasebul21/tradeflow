import { NextResponse, type NextRequest } from "next/server";
import { isDone, readTrace } from "@/agent/trace-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (status: number, type: string, message: string) =>
  NextResponse.json({ status: "error", error: { type, message, recoverable: false } }, { status });

/** The trace lines of one run, in file order: { run_id, done, lines }. Reads only logs/trace-<run_id>.jsonl. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ run_id: string }> }) {
  const { run_id: runId } = await params;
  const read = await readTrace(runId);
  if (!read.ok) return error(read.status, read.type, read.message);
  return NextResponse.json({ run_id: runId, done: isDone(read.lines), lines: read.lines });
}
