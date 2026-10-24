import { describe, expect, it, vi } from "vitest";

vi.mock("antd", async (importOriginal) => (await import("../../render-for-tests")).inlinePopups(await importOriginal()));

import type { TaskMetrics } from "@/agent/metrics";
import { html, render } from "../../render-for-tests";
import { MetricsView, type MetricsGroup } from "./view";

const metrics = { by_status: { success: 2, needs_human: 1, error: 0, unknown: 0 }, queries: { zetaris: 0, local: 9, local_fallback: 0 } } as unknown as TaskMetrics;
const groups: MetricsGroup[] = [
  { task: "all", metrics, rows: [["Runs", "3"]] },
  { task: "explain_week", metrics, rows: [["Runs", "3"]] },
];

describe("the metrics page", () => {
  it("15: says where the numbers come from in plain words and names tasks by their tab", () => {
    const page = render(<MetricsView runsRead={3} groups={groups} versions={[{ agent: "Planner", prompt_hash: "1a2b3c4d", runs: 3 }]} />);
    expect(page).toContain("Counted from the newest 3 runs on this computer.");
    expect(page).not.toContain("logs/");
    expect(page).toContain(">My week<");
    expect(page).toContain("Prompt versions (for developers)");
  });

  it("15: with no runs, says what to do", () => {
    expect(render(<MetricsView runsRead={0} groups={[]} versions={[]} />)).toContain(html("No runs yet. Run a review on the Analysis & Verification page, then come back."));
  });
});
