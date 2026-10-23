import { reviewQueue } from "@/agent/trace-read";
import { QueueView } from "./view";
import { waitingFor } from "../trace-steps";

// logs/ is read on each request, never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every run that ended needs_human, newest first, each with why it waits and a link to its trace. */
export default async function QueuePage() {
  const runs = await reviewQueue();
  return <QueueView runs={runs.map((run) => ({ ...run, waiting_for: waitingFor(run) }))} />;
}
