import { describe, expect, it } from "vitest";
import type { TraceLine } from "@/agent/trace";
import { stepRows, usageText, waitingFor } from "./trace-steps";

const line = (extra: Partial<TraceLine>): TraceLine => ({
  timestamp: "2026-10-01T10:00:00.000Z",
  run_id: "r",
  agent_name: "Planner",
  action: "plan_step",
  input_summary: "",
  output_summary: "",
  target_agent: null,
  model: null,
  confidence: null,
  retry_count: 0,
  status: "ok",
  ...extra,
});

describe("stepRows", () => {
  it("shows a Planner step's why, an Evaluator step's scores, a Query step's source and a Memory step's retrieval reason", () => {
    const rows = stepRows([
      line({ agent_name: "Planner", why: "The week's moves per holding.", model: "sample-model" }),
      line({ agent_name: "Evaluator", action: "accept", status: "accepted", confidence: 0.89, output_summary: "accuracy=3 appropriateness=3 actionability=2 total=8 of 9" }),
      line({ agent_name: "Query", action: "query", source: "local-fallback", usage: { query_calls: 1 } }),
      line({ agent_name: "Memory", action: "recall", retrievalReason: "matched the tag correction" }),
      line({ agent_name: "Guard", action: "allow", retry_count: 2 }),
    ]);
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0]).toMatchObject({ agent: "Planner", model: "sample-model", detail: { label: "Why this query", text: "The week's moves per holding." } });
    expect(rows[1]).toMatchObject({ confidence: 0.89, status: "accepted", detail: { label: "Scores", text: expect.stringContaining("total=8 of 9") } });
    expect(rows[2]).toMatchObject({ source: "local-fallback", usage: "1 query call", detail: { label: "Source", text: "local-fallback" } });
    expect(rows[3].detail).toEqual({ label: "Retrieval reason", text: "matched the tag correction" });
    expect(rows[4]).toMatchObject({ retry: 2, detail: null, why: null });
  });

  it("writes usage in words and nothing for a line without usage", () => {
    expect(usageText({ model_calls: 1, tokens_in: 310, tokens_out: 95 })).toBe("1 model call, 310 in / 95 out tokens");
    expect(usageText({ model_calls: 2, query_calls: 3 })).toBe("2 model calls, 3 query calls");
    expect(usageText(undefined)).toBeNull();
    expect(usageText({})).toBeNull();
  });
});

describe("waitingFor", () => {
  it("names a stop reason in words, an escalation rule, a reconciliation, and the fallback", () => {
    expect(waitingFor({ stop_reason: "rounds", escalation_rule: null })).toContain("round limit");
    expect(waitingFor({ stop_reason: "made_up", escalation_rule: null })).toBe("The run stopped: made_up.");
    expect(waitingFor({ stop_reason: "cancelled", escalation_rule: null })).toContain("You stopped the run");
    expect(waitingFor({ stop_reason: null, escalation_rule: "sector_target" })).toContain("sector_target");
    expect(waitingFor({ stop_reason: null, escalation_rule: "reconcile_proposals" })).toContain("approve");
    expect(waitingFor({ stop_reason: null, escalation_rule: null })).toBe("The run waits for your decision.");
  });
});
