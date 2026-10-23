import { notFound } from "next/navigation";
import { proofFromTrace } from "@/agent/proof";
import { readTrace, isDone, summarise } from "@/agent/trace-read";
import { RunView } from "./view";

// logs/ is read on each request, never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One run's trace as a timeline, read through the same code as GET /run/<run_id> (the run_id check comes before any file read). */
export default async function RunPage({ params }: { params: Promise<{ run_id: string }> }) {
  const { run_id: runId } = await params;
  const read = await readTrace(runId);
  if (!read.ok) {
    if (read.status === 500) throw new Error(read.message);
    notFound();
  }
  return <RunView runId={runId} lines={read.lines} proof={proofFromTrace(read.lines)} done={isDone(read.lines)} summary={summarise(runId, read.lines)} />;
}
