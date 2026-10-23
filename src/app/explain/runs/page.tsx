import { listRuns } from "@/agent/trace-read";
import { RunsView } from "./view";

// logs/ is read on each request, never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every run in logs/, newest first, each with a link to its steps. */
export default async function RunsPage() {
  return <RunsView runs={await listRuns()} />;
}
