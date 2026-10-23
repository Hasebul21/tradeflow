import { describe, expect, it } from "vitest";
import { DISCLAIMER } from "./agents/writer";
import { checkExpectation, tracePathChecks, universalChecks, type TraceLine } from "./eval-checks";
import { PLANNER_FALLBACK_LABEL } from "./labels";
import type { RunOutput, RunResult } from "./orchestrator";

const usage = { model_calls: 4, query_calls: 5, tokens_in: 10, tokens_out: 5, duration_ms: 12 };

function result(output: Partial<RunOutput> | null, extra: Partial<RunResult> = {}): RunResult {
  const base: RunOutput = {
    summary: "BXPHARMA fell on its results.",
    review_markdown: `BXPHARMA moved against its sector.\n\n${DISCLAIMER}`,
    findings: [],
    gaps: [],
    citations: [],
    needs_human: false,
    declined_advice: false,
    injection_seen: false,
    memories_recalled: [],
    applied_corrections: [],
    rounds: 1,
    scores: null,
    model_source: "sample-model",
    partial: false,
    stop_reason: null,
  };
  return {
    run_id: "r",
    task: "explain_week",
    status: "success",
    output: output === null ? null : { ...base, ...output },
    error: null,
    agents: [],
    usage,
    trace_id: "r",
    log_file: null,
    execution_time_seconds: 0,
    ...extra,
  };
}

const failed = (checks: { name: string; pass: boolean }[]) => checks.filter((c) => !c.pass).map((c) => c.name);

describe("checkExpectation", () => {
  it("passes each kind when the result matches", () => {
    const r = result({
      memories_recalled: [{ id: "mem-1", tags: ["correction"] }],
      memory_ids_added: ["mem-2"],
      verdicts: [{ journal_id: "j-1", symbol: "X", verdict: "open", cites: [] }],
      escalation: { rule: "sector_target" } as RunOutput["escalation"],
      new_findings: [],
      declined_advice: true,
    });
    const checks = checkExpectation(
      r,
      {
        status: "success",
        min_citations: 0,
        must_mention_any: [["bxpharma"], ["nothing here", "sector"]],
        must_not_mention: ["you should sell"],
        memory_recalled: true,
        memory_recalled_tag: "correction",
        memory_added: true,
        verdicts_valid: true,
        verdicts: { "j-1": "open" },
        escalation_rule: "sector_target",
        new_findings: 0,
        declined_advice: true,
        injection_seen: false,
        no_model_call: false,
        note: "not checked",
      },
      false,
    );
    expect(failed(checks)).toEqual([]);
  });

  it("fails each kind when the result differs, and an unknown key", () => {
    const r = result({ verdicts: [{ journal_id: "j-1", symbol: "X", verdict: "maybe", cites: [] }] });
    const checks = checkExpectation(
      r,
      { status: "needs_human", min_citations: 3, must_mention_any: [["walton"]], must_not_mention: ["bxpharma"], memory_recalled: true, memory_recalled_tag: "correction", memory_added: true, verdicts_valid: true, escalation_rule: "sector_target", new_findings: 0, proposals: 4, no_model_call: true, injection_seen: true, typo: 1 },
      false,
    );
    expect(failed(checks)).toEqual(["status", "min_citations", "must_mention_any", "must_not_mention", "memory_recalled", "memory_recalled_tag", "memory_added", "verdicts_valid", "escalation_rule", "new_findings", "proposals", "no_model_call", "injection_seen", "typo"]);
  });

  it("checks the task a free question was routed to", () => {
    const r = { ...result({}), task: "pre_trade" };
    expect(failed(checkExpectation(r, { task: "pre_trade" }, false))).toEqual([]);
    expect(failed(checkExpectation(r, { task: "explain_week" }, false))).toEqual(["task"]);
  });

  it("checks error_type and recoverable on an error, and real_model only in a real-model run", () => {
    const r = result(null, { status: "error", error: { type: "InvalidInput", message: "x", recoverable: false } });
    expect(failed(checkExpectation(r, { status: "error", error_type: "InvalidInput", recoverable: false }, false))).toEqual([]);
    expect(failed(checkExpectation(r, { error_type: "Timeout", recoverable: true }, false))).toEqual(["error_type", "recoverable"]);
    const v = result({ verdicts: [{ journal_id: "j-1", symbol: "X", verdict: "open", cites: [] }] });
    const exp = { real_model: { verdicts: { "j-1": "confirmed" } } };
    expect(checkExpectation(v, exp, false)).toEqual([]);
    expect(failed(checkExpectation(v, exp, true))).toEqual(["verdicts"]);
  });
});

describe("universalChecks", () => {
  it("passes a result with usage, the disclaimer last and no advice", () => {
    expect(failed(universalChecks(result({})))).toEqual([]);
  });

  it("fails missing usage, a missing disclaimer and advice wording", () => {
    const r = result({ review_markdown: "You should sell BXPHARMA." }, { usage: undefined as unknown as RunResult["usage"] });
    expect(failed(universalChecks(r))).toEqual(["usage", "disclaimer", "no_advice"]);
  });

  it("fails a result that ended model_unavailable with exactly that check, even when the case expects needs_human", () => {
    const r = result({ stop_reason: "model_unavailable", partial: true, needs_human: true }, { status: "needs_human" });
    expect(failed(universalChecks(r))).toEqual(["model_unavailable: the model failed after the queries"]);
    expect(failed(checkExpectation(r, { status: "needs_human" }, false))).toEqual([]);
  });

  it("fails a successful result whose plan code built after the Planner failed, whatever the cause", () => {
    for (const cause of ["its replies could not be read", "the model service returned an error", "the model call timed out", "the model service was busy and refused the call", "the model service could not be reached"]) {
      const r = result({ gaps: [`${PLANNER_FALLBACK_LABEL} (${cause}; queries: week_moves, rule_findings); the review covers those, not a plan made for this question.`] });
      expect(failed(universalChecks(r))).toEqual(["planner_fallback: the plan was built in code"]);
    }
    expect(failed(universalChecks(result({ gaps: ["dividends_between returned no rows."] })))).toEqual([]);
  });

  it("skips an error result", () => {
    expect(universalChecks(result(null, { status: "error" }))).toEqual([]);
  });
});

describe("tracePathChecks", () => {
  const line = (agent_name: string, action: string, output_summary = ""): TraceLine => ({ agent_name, action, output_summary });

  it("passes explain_week in order with the planned query and recall first", () => {
    const lines = [line("Memory", "recall", "by_tag=mem-3; by_query=none"), line("Planner", "plan_step", "rule_findings {}"), line("Analyst", "analyse"), line("Evaluator", "accept"), line("Writer", "write")];
    expect(failed(tracePathChecks("example_2", result({}), lines))).toEqual([]);
    expect(failed(tracePathChecks("example_3b", result({}), lines))).toEqual([]);
  });

  it("fails explain_week out of order, a missing plan and a recall with nothing", () => {
    const lines = [line("Memory", "recall", "by_tag=none; by_query=none"), line("Planner", "plan_step", "week_moves {}"), line("Writer", "write"), line("Analyst", "analyse"), line("Evaluator", "accept")];
    expect(failed(tracePathChecks("example_2", result({}), lines))).toEqual(["path", "plans"]);
    expect(failed(tracePathChecks("example_7b", result({}), lines))).toEqual(["path", "recall_first"]);
  });

  it("needs pre_trade's fixed_plan with what_if and no Planner, and feedback with no Planner", () => {
    const pre = result({}, { task: "pre_trade" });
    expect(failed(tracePathChecks("p", pre, [line("Orchestrator", "fixed_plan", "5 steps, no Planner call: what_if, rule_findings")]))).toEqual([]);
    expect(failed(tracePathChecks("p", pre, [line("Orchestrator", "fixed_plan", "rule_findings"), line("Planner", "plan")]))).toEqual(["path"]);
    const fb = result({}, { task: "feedback" });
    expect(failed(tracePathChecks("f", fb, [line("Memory", "learn")]))).toEqual([]);
    expect(failed(tracePathChecks("f", fb, [line("Planner", "plan")]))).toEqual(["path"]);
  });

  it("needs the Guard's as_of move for non-trading-day", () => {
    const lines = [line("Planner", "plan"), line("Analyst", "a"), line("Evaluator", "e"), line("Writer", "w")];
    expect(failed(tracePathChecks("non-trading-day", result({}), lines))).toEqual(["as_of_moved"]);
    const moved = [line("Guard", "as_of_moved", "as_of moved from 2026-09-26 to 2026-09-24"), ...lines];
    expect(failed(tracePathChecks("non-trading-day", result({}), moved))).toEqual([]);
  });
});

describe("checkExpectation no_query", () => {
  const ok = result({});
  const line = (agent_name: string, action: string, input_summary: string, extra: Partial<TraceLine> = {}): TraceLine => ({ agent_name, action, input_summary, output_summary: "14 rows", status: "ok", ...extra });

  it("passes when no Query or tool_call line ran the query; a policy_denied line and a refused tool_call do not count", () => {
    const trace = [
      line("Query", "query", 'week_moves {"as_of":"2026-10-01"} source=local'),
      line("Guard", "policy_denied", "beforeQuery what_if {}", { status: "blocked" }),
      line("Analyst", "tool_call", 'what_if {"symbol":"WALTONHIL"}', { output_summary: "not run: policy: Analyst may not run what_if for explain_week", status: "blocked" }),
    ];
    expect(checkExpectation(ok, { no_query: "what_if" }, false, trace)).toEqual([expect.objectContaining({ name: "no_query", pass: true })]);
  });

  it("fails when a Query line or a tool_call that ran what_if is in the trace", () => {
    const queried = [line("Query", "query", 'what_if {"symbol":"WALTONHIL"} source=local')];
    expect(checkExpectation(ok, { no_query: "what_if" }, false, queried)).toEqual([expect.objectContaining({ name: "no_query", pass: false })]);
    const tooled = [line("Analyst", "tool_call", 'what_if {"symbol":"WALTONHIL"}', { output_summary: "3 rows, run_query_id abc" })];
    expect(checkExpectation(ok, { no_query: "what_if" }, false, tooled)).toEqual([expect.objectContaining({ name: "no_query", pass: false })]);
  });
});
