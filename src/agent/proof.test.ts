import { describe, expect, it } from "vitest";
import { proofFromTrace, type ProofLine } from "./proof";

// A made-up trace of 9 lines.
const FIXTURE: ProofLine[] = [
  { agent_name: "Query", action: "query", status: "ok", source: "zetaris" },
  { agent_name: "Query", action: "query", status: "fallback", source: "local-fallback" },
  { agent_name: "Memory", action: "recall", status: "ok", output_summary: "by_tag=mem-1,mem-2; by_query=none; corrections=mem-2" },
  { agent_name: "World", action: "record", status: "ok", output_summary: "entities=2; facts=3; relations=1; run_query_ids=q1" },
  { agent_name: "Planner", action: "model_call", status: "ok", model: "model-a", usage: { tokens_in: 100, tokens_out: 10, model_calls: 1 } },
  { agent_name: "Analyst", action: "model_call", status: "fallback", model: "model-b", fallback: "strong->main", usage: { tokens_in: 50, tokens_out: 5, model_calls: 1 } },
  { agent_name: "Guard", action: "block", status: "blocked", output_summary: "no" },
  { agent_name: "Evaluator", action: "reject", status: "rejected", confidence: 0.44, why: "Cite a run." },
  { agent_name: "Evaluator", action: "accept", status: "accepted", confidence: 0.78 },
];

describe("proofFromTrace", () => {
  it("counts exactly what the lines say", () => {
    expect(proofFromTrace(FIXTURE)).toEqual({
      zetaris: { queries: 2, via_zetaris: 1, local: 0, fallback: 1 },
      meterless: { memories_recalled: 2, taken_by_tag: 2, corrections_applied: 1, world_facts_written: 3 },
      nemotron: { models: [{ model_id: "model-a", calls: 1 }, { model_id: "model-b", calls: 1 }], tokens_in: 150, tokens_out: 15, strong_to_main_fallbacks: 1 },
      guards: { checked: 1, blocked: 1, injections_flagged: 0, advice_declined: 0 },
      loop: { rounds: 2, rejected_rounds: 1, final_score_out_of_9: 7 },
    });
  });

  it("gives zeros for an empty trace", () => {
    expect(proofFromTrace([])).toEqual({
      zetaris: { queries: 0, via_zetaris: 0, local: 0, fallback: 0 },
      meterless: { memories_recalled: 0, taken_by_tag: 0, corrections_applied: 0, world_facts_written: 0 },
      nemotron: { models: [], tokens_in: 0, tokens_out: 0, strong_to_main_fallbacks: 0 },
      guards: { checked: 0, blocked: 0, injections_flagged: 0, advice_declined: 0 },
      loop: { rounds: 0, rejected_rounds: 0, final_score_out_of_9: 0 },
    });
  });

  it("does not count a cached query", () => {
    expect(proofFromTrace([{ agent_name: "Query", action: "cached", status: "cached", source: "local" }]).zetaris.queries).toBe(0);
  });
});
