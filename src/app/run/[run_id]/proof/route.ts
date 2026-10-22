import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { RUN_ID_PATTERN } from "@/agent/orchestrator";
import { proofFromTrace, type ProofLine } from "@/agent/proof";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (status: number, type: string, message: string) =>
  NextResponse.json({ status: "error", error: { type, message, recoverable: false } }, { status });

/** The proof counts of one run, from logs/trace-<run_id>.jsonl alone. The numbers grow while the run is still going. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ run_id: string }> }) {
  const { run_id: runId } = await params;
  if (!RUN_ID_PATTERN.test(runId)) return error(400, "InvalidInput", "run_id must match /^[A-Za-z0-9_-]{1,80}$/.");
  let raw: string;
  try {
    raw = await readFile(path.resolve(process.cwd(), "logs", `trace-${runId}.jsonl`), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return error(404, "NotFound", `No trace for run ${runId}.`);
    return error(500, "Internal", "The trace could not be read.");
  }
  const lines: ProofLine[] = [];
  for (const row of raw.split("\n")) {
    if (row.trim() === "") continue;
    try {
      lines.push(JSON.parse(row) as ProofLine);
    } catch {
      // A line still being written is skipped; the next poll has it.
    }
  }
  return NextResponse.json(proofFromTrace(lines));
}
