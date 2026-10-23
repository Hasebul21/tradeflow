import { ALL_RUNS, DEFAULT_RUN_LIMIT, metricRows, metricsFromTraces, promptVersionRows, readRuns } from "@/agent/metrics";
import { MetricsView } from "./view";

// logs/ is read on each request, never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The same numbers as GET /metrics: one table per task, all runs first. */
export default async function MetricsPage() {
  const runs = await readRuns("logs", DEFAULT_RUN_LIMIT);
  const metrics = metricsFromTraces(runs);
  const tasks = [ALL_RUNS, ...Object.keys(metrics).filter((key) => key !== ALL_RUNS)];
  return (
    <MetricsView
      runsRead={runs.length}
      groups={tasks.map((task) => ({ task, metrics: metrics[task], rows: metricRows(metrics[task]) }))}
      versions={promptVersionRows(metrics[ALL_RUNS])}
    />
  );
}
