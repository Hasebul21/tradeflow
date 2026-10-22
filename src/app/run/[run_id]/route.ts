import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { RUN_ID_PATTERN } from "@/agent/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (status: number, type: string, message: string) =>
  NextResponse.json({ status: "error", error: { type, message, recoverable: false } }, { status });

type Line = { agent_name?: unknown; action?: unknown; status?: unknown };

/** The run is over when the last line is the Orchestrator's run_end line or has a status of error. */
function isDone(lines: Line[]): boolean {
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  return (last.agent_name === "Orchestrator" && last.action === "run_end") || last.status === "error";
}

/** The trace lines of one run, in file order: { run_id, done, lines }. Reads only logs/trace-<run_id>.jsonl. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ run_id: string }> }) {
  const { run_id: runId } = await params;
  if (!RUN_ID_PATTERN.test(runId)) return error(400, "InvalidInput", "run_id must match /^[A-Za-z0-9_-]{1,80}$/.");
  let text: string;
  try {
    text = await readFile(path.resolve(process.cwd(), "logs", `trace-${runId}.jsonl`), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return error(404, "NotFound", `No trace for run ${runId}.`);
    return error(500, "Internal", "The trace could not be read.");
  }
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      // A line that is still being written is skipped; the next poll has it.
    }
  }
  return NextResponse.json({ run_id: runId, done: isDone(lines), lines });
}
