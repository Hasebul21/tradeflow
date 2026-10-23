import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../src/agent/orchestrator";
import { evalExitCode, evaluate, listCases, writeResults, type Checks, type EvalCase, type Row, type RunGroup } from "./eval-cases";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const noChecks: Checks = { checkExpectation: () => [], universalChecks: () => [], tracePathChecks: () => [] };

function fakeResult(id: string): RunResult {
  return {
    run_id: id,
    task: "explain_week",
    status: "success",
    output: null,
    error: null,
    agents: [],
    usage: { model_calls: 1, query_calls: 1, tokens_in: 1, tokens_out: 1, duration_ms: 1 },
    trace_id: id,
    log_file: null,
    execution_time_seconds: 0,
  } as unknown as RunResult;
}

/** A stub runner: each case sleeps `lengthOf(id)` ms; it counts how many cases run at once and the finish order. */
function stubRunner(lengthOf: (id: string) => number) {
  const stats = { running: 0, peak: 0, finished: [] as string[] };
  const runGroup: RunGroup = async (group, _index, report) => {
    for (const item of group) {
      stats.running += 1;
      stats.peak = Math.max(stats.peak, stats.running);
      await sleep(lengthOf(item.id));
      stats.running -= 1;
      stats.finished.push(item.id);
      report(item.id, { result: fakeResult(item.id), seconds: lengthOf(item.id) / 1000 });
    }
  };
  return { runGroup, stats };
}

const stubCases = (ids: string[]): EvalCase[] => ids.map((id) => ({ id, body: { run_id: id }, exp: undefined, dataDir: undefined, skipped: false }));

let tmp: string | null = null;
afterEach(() => {
  if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("evaluate with concurrency 3", () => {
  it("runs at most 3 stubbed cases of different lengths at once", async () => {
    const lengths: Record<string, number> = { a: 120, b: 30, c: 80, d: 20, e: 60, f: 100, g: 40, h: 10 };
    const { runGroup, stats } = stubRunner((id) => lengths[id]);
    const { rows, errors } = await evaluate(stubCases(Object.keys(lengths)), { concurrency: 3, real: false, checks: noChecks, runGroup, chains: [] });
    expect(stats.peak).toBe(3);
    expect(rows.map((row) => row.verdict)).toEqual(Array(8).fill("pass"));
    expect(errors).toEqual([]);
  });

  it("starts the chain first, ahead of lone cases listed before it", async () => {
    const { runGroup, stats } = stubRunner(() => 5);
    const started: string[] = [];
    const wrapped: RunGroup = (group, index, report) => {
      started.push(group[0].id);
      return runGroup(group, index, report);
    };
    await evaluate(stubCases(["a", "b", "c", "d"]), { concurrency: 2, real: false, checks: noChecks, runGroup: wrapped, chains: [["c", "d"]] });
    expect(started[0]).toBe("c");
    expect(stats.finished).toHaveLength(4);
  });

  it("writes RESULTS.md rows in the usual case order, though later cases finish first", async () => {
    const cases = listCases(process.cwd());
    const runnable = cases.filter((item) => !item.skipped).map((item) => item.id);
    const { runGroup, stats } = stubRunner((id) => 5 * (runnable.length - runnable.indexOf(id)));
    const { rows } = await evaluate(cases, { concurrency: 3, real: false, checks: noChecks, runGroup });
    expect(stats.finished).not.toEqual(runnable);
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-results-"));
    const file = path.join(tmp, "RESULTS.md");
    writeResults(file, rows, false, { commit: "test", models: {}, host: "unknown", concurrency: 3 });
    const text = readFileSync(file, "utf8");
    const tableIds = text
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| case "))
      .map((line) => line.split("|")[1].trim());
    expect(tableIds).toEqual(cases.map((item) => item.id));
    expect(text).toContain("| case | result | status | citations | rounds | Evaluator total | model calls | query calls | tokens | seconds | failed check |");
    expect(text).not.toContain("- Concurrency:");
  });

  it("adds a Concurrency line to a real-model section only when concurrency is above 1", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-results-"));
    const file = path.join(tmp, "RESULTS.md");
    const rows = stubCases(["a"]).map((item) => ({ id: item.id, verdict: "pass" as const, result: fakeResult(item.id), failed: [], seconds: 1 }));
    writeResults(file, rows, true, { commit: "abc", models: {}, host: "h", concurrency: 1 });
    expect(readFileSync(file, "utf8")).not.toContain("- Concurrency:");
    writeResults(file, rows, true, { commit: "abc", models: {}, host: "h", concurrency: 3 });
    expect(readFileSync(file, "utf8").split("## Real model, run 2")[1]).toContain("- Concurrency: 3");
  });

  it("fails the unfinished cases of a rejected group and returns its reason, keeping the others", async () => {
    const runGroup: RunGroup = async (group, _index, report) => {
      for (const item of group) {
        if (item.id === "b") throw new Error("worker stopped");
        report(item.id, { result: fakeResult(item.id), seconds: 0 });
      }
    };
    const { rows, errors } = await evaluate(stubCases(["a", "b", "c", "d"]), { concurrency: 3, real: false, checks: noChecks, runGroup, chains: [["a", "b", "c"]] });
    expect(rows.map((row) => [row.id, row.verdict])).toEqual([["a", "pass"], ["b", "fail"], ["c", "fail"], ["d", "pass"]]);
    expect(rows[1].failed).toEqual([{ name: "run", pass: false, detail: "worker stopped" }]);
    expect(errors).toEqual([{ ids: ["a", "b", "c"], reason: "worker stopped" }]);
  });

  it("returns the rejection of a group that reported every case before it failed", async () => {
    const runGroup: RunGroup = async (group, _index, report) => {
      for (const item of group) report(item.id, { result: fakeResult(item.id), seconds: 0 });
      if (group[0].id === "a") throw new Error("worker exit code 1");
    };
    const { rows, errors } = await evaluate(stubCases(["a", "b"]), { concurrency: 3, real: false, checks: noChecks, runGroup, chains: [] });
    expect(rows.map((row) => row.verdict)).toEqual(["pass", "pass"]);
    expect(errors).toEqual([{ ids: ["a"], reason: "worker exit code 1" }]);
  });

  it("writes a fail row for a case its group never reported, though the group resolved", async () => {
    const runGroup: RunGroup = async (group, _index, report) => {
      for (const item of group) if (item.id !== "b") report(item.id, { result: fakeResult(item.id), seconds: 0 });
    };
    const { rows, errors } = await evaluate(stubCases(["a", "b", "c"]), { concurrency: 3, real: false, checks: noChecks, runGroup, chains: [["a", "b"]] });
    expect(rows.map((row) => [row.id, row.verdict])).toEqual([["a", "pass"], ["b", "fail"], ["c", "pass"]]);
    expect(rows[1].failed).toEqual([{ name: "run", pass: false, detail: "no result: its group finished without running it" }]);
    expect(errors).toEqual([]);
  });
});

describe("evalExitCode", () => {
  const row = (id: string, verdict: Row["verdict"]): Row => ({ id, verdict, result: null, failed: [], seconds: 0 });

  it("is 0 for passes, skips and rate limits with no stopped group", () => {
    expect(evalExitCode([row("a", "pass"), row("b", "skipped"), row("c", "rate-limited")], [])).toBe(0);
  });

  it("is 1 for a failed check or a case with no result", () => {
    expect(evalExitCode([row("a", "pass"), row("b", "fail")], [])).toBe(1);
  });

  it("is 1 for a group that stopped after reporting every case as a pass", () => {
    expect(evalExitCode([row("a", "pass")], [{ ids: ["a"], reason: "exit code 1" }])).toBe(1);
  });

  it("adds a Failed groups line to the results section when a group stopped", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-results-"));
    const file = path.join(tmp, "RESULTS.md");
    writeResults(file, [row("a", "pass")], false, { commit: "c", models: {}, host: "h", failedGroups: [{ ids: ["a", "b"], reason: "the eval worker stopped (exit code 1)" }] });
    expect(readFileSync(file, "utf8")).toContain("- Failed groups: a, b (the eval worker stopped (exit code 1))");
    writeResults(file, [row("a", "pass")], false, { commit: "c", models: {}, host: "h" });
    expect(readFileSync(file, "utf8")).not.toContain("- Failed groups:");
  });
});
