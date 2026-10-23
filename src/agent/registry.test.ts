import { afterEach, describe, expect, it } from "vitest";
import { active, cancel, register, release, topLevelCount } from "./registry";

afterEach(() => {
  for (const { run_id } of active()) release(run_id);
});

describe("the run registry", () => {
  it("counts two top-level runs and one child, lists all three with elapsed_ms, and is empty after release", async () => {
    register({ run_id: "reg-a", task: "explain_week" });
    register({ run_id: "reg-b", task: "briefing" });
    register({ run_id: "reg-b-1-explain_week", task: "explain_week", parent_run_id: "reg-b" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(topLevelCount()).toBe(2);
    const runs = active();
    expect(runs).toHaveLength(3);
    for (const entry of runs) {
      expect(typeof entry.elapsed_ms).toBe("number");
      expect(entry.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(entry.started_at))).toBe(false);
    }
    expect(runs.find((entry) => entry.run_id === "reg-b-1-explain_week")).toMatchObject({ task: "explain_week", parent_run_id: "reg-b" });
    expect(runs.find((entry) => entry.run_id === "reg-a")?.parent_run_id).toBeNull();
    // Only these five fields: nothing from the request is kept.
    expect(Object.keys(runs[0]).sort()).toEqual(["elapsed_ms", "parent_run_id", "run_id", "started_at", "task"]);

    release("reg-a");
    release("reg-b");
    release("reg-b-1-explain_week");
    expect(active()).toEqual([]);
    expect(topLevelCount()).toBe(0);
  });

  it("cancel aborts a running id and returns false for an unknown one", () => {
    const signal = register({ run_id: "reg-cancel", task: "explain_week" });
    expect(signal.aborted).toBe(false);
    expect(cancel("reg-cancel")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(cancel("reg-unknown")).toBe(false);
  });

  it("release with a signal leaves a newer run that took the same id", () => {
    const first = register({ run_id: "reg-same", task: "explain_week" });
    const second = register({ run_id: "reg-same", task: "explain_week" });
    release("reg-same", first);
    expect(active().map((entry) => entry.run_id)).toEqual(["reg-same"]);
    expect(cancel("reg-same")).toBe(true);
    expect(second.aborted).toBe(true);
    expect(first.aborted).toBe(false);
  });

  it("is one map for the whole process: it lives on globalThis", () => {
    register({ run_id: "reg-global", task: "explain_week" });
    const holder = globalThis as unknown as Record<symbol, Map<string, unknown>>;
    expect(holder[Symbol.for("tradeflow.run-registry")].has("reg-global")).toBe(true);
  });
});
