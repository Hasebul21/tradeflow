import { NextResponse, type NextRequest } from "next/server";
import { proofFromTrace } from "@/agent/proof";
import { readTrace } from "@/agent/trace-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (status: number, type: string, message: string) =>
  NextResponse.json({ status: "error", error: { type, message, recoverable: false } }, { status });

/** The proof counts of one run, from logs/trace-<run_id>.jsonl alone. The numbers grow while the run is still going. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ run_id: string }> }) {
  const { run_id: runId } = await params;
  const read = await readTrace(runId);
  if (!read.ok) return error(read.status, read.type, read.message);
  return NextResponse.json(proofFromTrace(read.lines));
}
