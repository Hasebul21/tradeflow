import { describe, expect, it, vi } from "vitest";

vi.mock("antd", async (importOriginal) => (await import("../../render-for-tests")).inlinePopups(await importOriginal()));

import type { RunSummary } from "@/agent/trace-read";
import { html, render } from "../../render-for-tests";
import { RunsView } from "./view";

const RUN: RunSummary = { run_id: "orch-pol-1", task: "thesis_check", as_of: "2026-10-01", status: "success", stop_reason: null, escalation_rule: null, summary: "", at: "2026-10-23T02:42:49.000Z" };

describe("past runs", () => {
  it("2: lists every run with a link to its steps", () => {
    const page = render(<RunsView runs={[RUN]} />);
    expect(page).toContain(">Past runs<");
    expect(page).toContain('href="/explain/runs/orch-pol-1"');
    expect(page).toContain(">Strategy &amp; Hypotheses<");
    expect(page).toContain('data-tooltip="The review passed its checks."');
  });

  it("2: with no runs, says what to do", () => {
    expect(render(<RunsView runs={[]} />)).toContain(html("No runs yet. Run a review on the Analysis & Verification page, then come back."));
  });
});
