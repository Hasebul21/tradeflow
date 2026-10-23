import { describe, expect, it, vi } from "vitest";

vi.mock("antd", async (importOriginal) => (await import("../../render-for-tests")).inlinePopups(await importOriginal()));

import { render } from "../../render-for-tests";
import { QueueView, type QueueRun } from "./view";

const RUN: QueueRun = {
  run_id: "0a80d597-2879-431e-b1a7-64140b6b5431",
  task: "explain_week",
  as_of: "2026-10-01",
  status: "needs_human",
  stop_reason: "rounds",
  escalation_rule: null,
  summary: "",
  at: "2026-10-23T02:42:49.000Z",
  waiting_for: "The draft was not accepted within the round limit. The findings are the best draft, unreviewed.",
};

describe("the review queue", () => {
  it("15: shows the task by its tab name, a short run id, the time zone and no stop code", () => {
    const page = render(<QueueView runs={[RUN]} />);
    expect(page).toContain(">My week<");
    expect(page).toContain(">0a80d597<");
    expect(page).toContain('data-tooltip="0a80d597-2879-431e-b1a7-64140b6b5431"');
    expect(page).toContain("Finished (UTC)");
    expect(page).toContain("The draft was not accepted within the round limit.");
    expect(page).not.toContain(">rounds<");
    expect(page).not.toContain(">explain_week<");
  });

  it("15: the empty queue says when runs appear", () => {
    expect(render(<QueueView runs={[]} />)).toContain("No run is waiting for you. Runs that need your decision appear here after you use Explain.");
  });
});
