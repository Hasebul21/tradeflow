// Made-up runs for the Explain page's render tests. Shapes follow src/agent/orchestrator.ts and src/agent/proof.ts.
import type { Citation, RunResult } from "@/agent/orchestrator";
import type { Proof } from "@/agent/proof";
import type { TraceLine } from "@/agent/trace";
import type { RunState } from "./view";

export const RANGE = { first: "2026-01-11", last: "2026-10-01" };

export const USAGE = { model_calls: 3, query_calls: 5, tokens_in: 1200, tokens_out: 300, duration_ms: 4200 };

export function citation(over: Partial<Citation> = {}): Citation {
  return {
    run_query_id: "q1",
    query_id: "week_moves",
    params: { as_of: "2026-10-01" },
    source: "local",
    row_count: 1,
    rows: [{ symbol: "BXPHARMA", change_pct: -4.2 }],
    ...over,
  } as Citation;
}

type Output = NonNullable<RunResult["output"]>;

export function output(over: Partial<Output> = {}): Output {
  return {
    summary: "The portfolio fell 1.2% this week.",
    review_markdown: "- BXPHARMA fell 4.2%. [q:q1]",
    findings: [],
    gaps: [],
    citations: [citation()],
    needs_human: false,
    declined_advice: false,
    injection_seen: false,
    memories_recalled: [],
    applied_corrections: [],
    rounds: 1,
    scores: { accuracy: 3, appropriateness: 3, actionability: 3, total: 9 },
    model_source: "sample-model",
    partial: false,
    stop_reason: null,
    escalation: null,
    ...over,
  } as unknown as Output;
}

export function result(over: Partial<RunResult> = {}, out: Partial<Output> = {}): RunResult {
  return {
    run_id: "run-1",
    task: "explain_week",
    status: "success",
    output: output(out),
    error: null,
    agents: [],
    usage: USAGE,
    trace_id: "run-1",
    log_file: null,
    execution_time_seconds: 4.2,
    ...over,
  } as unknown as RunResult;
}

export function state(run: RunResult | null, over: Partial<RunState> = {}): RunState {
  return { running: false, runId: run?.run_id ?? null, steps: [], started: true, result: run, proof: null, stopping: false, ...over };
}

export const PROOF: Proof = {
  zetaris: { queries: 5, via_zetaris: 0, local: 5, fallback: 0 },
  meterless: { memories_recalled: 2, taken_by_tag: 1, corrections_applied: 0, world_facts_written: 3 },
  nemotron: { models: [{ model_id: "sample-model", calls: 3 }], tokens_in: 1200, tokens_out: 300, strong_to_main_fallbacks: 0 },
  guards: { checked: 9, blocked: 0, injections_flagged: 0, advice_declined: 0 },
  loop: { rounds: 1, rejected_rounds: 0, final_score_out_of_9: 9 },
};

export function line(over: Partial<TraceLine> = {}): TraceLine {
  return {
    timestamp: "2026-10-23T02:42:49.000Z",
    run_id: "run-1",
    task: "explain_week",
    agent_name: "Planner",
    action: "plan_step",
    input_summary: "",
    output_summary: "",
    target_agent: "Analyst",
    model: null,
    confidence: null,
    retry_count: 0,
    status: "ok",
    ...over,
  } as TraceLine;
}
