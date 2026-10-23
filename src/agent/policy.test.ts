import { describe, expect, it } from "vitest";
import { allowedMemoryWrite, allowedQuery } from "./policy";

describe("allowedQuery", () => {
  it("refuses the Analyst what_if for explain_week, and the reason names the caller, the task and the query", () => {
    const verdict = allowedQuery({ caller: "Analyst", task: "explain_week", query_id: "what_if" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("policy: Analyst may not run what_if for explain_week");
  });

  it("lets the Analyst run week_moves for explain_week", () => {
    expect(allowedQuery({ caller: "Analyst", task: "explain_week", query_id: "week_moves" }).ok).toBe(true);
  });

  it("lets the Orchestrator run what_if for pre_trade", () => {
    expect(allowedQuery({ caller: "Orchestrator", task: "pre_trade", query_id: "what_if" }).ok).toBe(true);
  });

  it("refuses the Orchestrator what_if for explain_week", () => {
    const verdict = allowedQuery({ caller: "Orchestrator", task: "explain_week", query_id: "what_if" });
    expect(verdict).toEqual({ ok: false, reason: "policy: Orchestrator may not run what_if for explain_week" });
  });

  it("refuses the Writer every query, even one in the task's catalogue", () => {
    const verdict = allowedQuery({ caller: "Writer", task: "explain_week", query_id: "week_moves" });
    expect(verdict).toEqual({ ok: false, reason: "policy: Writer may not run week_moves for explain_week" });
  });

  it("refuses the Planner, the Evaluator and the Router every query", () => {
    for (const caller of ["Planner", "Evaluator", "Router"]) {
      expect(allowedQuery({ caller, task: "explain_week", query_id: "week_moves" }).ok).toBe(false);
    }
  });

  it("gives reconcile and reconcile_approve the reconciliation query, and no other task", () => {
    expect(allowedQuery({ caller: "Orchestrator", task: "reconcile", query_id: "reconciliation" }).ok).toBe(true);
    expect(allowedQuery({ caller: "Orchestrator", task: "reconcile_approve", query_id: "reconciliation" }).ok).toBe(true);
    expect(allowedQuery({ caller: "Orchestrator", task: "thesis_check", query_id: "reconciliation" }).ok).toBe(false);
    expect(allowedQuery({ caller: "Orchestrator", task: "reconcile_approve", query_id: "what_if" }).ok).toBe(false);
  });

  it("refuses a caller or a task the table does not know", () => {
    expect(allowedQuery({ caller: "Intruder", task: "explain_week", query_id: "week_moves" }).ok).toBe(false);
    expect(allowedQuery({ caller: "Orchestrator", task: "no_such_task", query_id: "week_moves" }).ok).toBe(false);
    expect(allowedQuery({ caller: "Orchestrator", task: "feedback", query_id: "week_moves" }).ok).toBe(false);
  });
});

describe("allowedMemoryWrite", () => {
  it("refuses the Writer a decision, and the reason names the caller and the kind", () => {
    const verdict = allowedMemoryWrite({ caller: "Writer", kind: "decision" });
    expect(verdict).toEqual({ ok: false, reason: "policy: Writer may not write a decision memory" });
  });

  it("lets reconcile_approve write a decision", () => {
    expect(allowedMemoryWrite({ caller: "reconcile_approve", kind: "decision" }).ok).toBe(true);
  });

  it("refuses feedback a review", () => {
    expect(allowedMemoryWrite({ caller: "feedback", kind: "review" })).toEqual({ ok: false, reason: "policy: feedback may not write a review memory" });
  });

  it("lets the Writer write a review and feedback write a correction", () => {
    expect(allowedMemoryWrite({ caller: "Writer", kind: "review" }).ok).toBe(true);
    expect(allowedMemoryWrite({ caller: "feedback", kind: "correction" }).ok).toBe(true);
  });

  it("never lets a model agent write a correction or a decision, and refuses an unknown caller", () => {
    for (const caller of ["Planner", "Analyst", "Evaluator", "Writer", "Router"]) {
      for (const kind of ["correction", "decision"]) expect(allowedMemoryWrite({ caller, kind }).ok).toBe(false);
    }
    expect(allowedMemoryWrite({ caller: "Intruder", kind: "review" }).ok).toBe(false);
  });
});
