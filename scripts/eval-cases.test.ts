import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../src/agent/orchestrator";
import { evaluate, listCases, writeResults, type Checks, type EvalCase, type RunGroup } from "./eval-cases";

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
  it("runs at most 3 stubbed cases of different lengths at once and finishes sooner than one by one", async () => {
    const lengths: Record<string, number> = { a: 120, b: 30, c: 80, d: 20, e: 60, f: 100, g: 40, h: 10 };
    const { runGroup, stats } = stubRunner((id) => lengths[id]);
    const started = Date.now();
    const rows = await evaluate(stubCases(Object.keys(lengths)), { concurrency: 3, real: false, checks: noChecks, runGroup, chains: [] });
    const took = Date.now() - started;
    const oneByOne = Object.values(lengths).reduce((sum, ms) => sum + ms, 0);
    expect(stats.peak).toBe(3);
    expect(took).toBeLessThan(oneByOne);
    expect(rows.map((row) => row.verdict)).toEqual(Array(8).fill("pass"));
  });

  it("writes RESULTS.md rows in the usual case order, though later cases finish first", async () => {
    const cases = listCases(process.cwd());
    const runnable = cases.filter((item) => !item.skipped).map((item) => item.id);
    const { runGroup, stats } = stubRunner((id) => 5 * (runnable.length - runnable.indexOf(id)));
    const rows = await evaluate(cases, { concurrency: 3, real: false, checks: noChecks, runGroup });
    expect(stats.finished).not.toEqual(runnable);
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-results-"));
    const file = path.join(tmp, "RESULTS.md");
    writeResults(file, rows, false, { commit: "test", models: {}, host: "unknown" });
    const text = readFileSync(file, "utf8");
    const tableIds = text
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| case "))
      .map((line) => line.split("|")[1].trim());
    expect(tableIds).toEqual(cases.map((item) => item.id));
    expect(text).toContain("| case | result | status | citations | rounds | Evaluator total | model calls | query calls | tokens | seconds | failed check |");
  });

  it("marks the unfinished cases of a group whose runner fails as failed, and keeps the others", async () => {
    const runGroup: RunGroup = async (group, _index, report) => {
      for (const item of group) {
        if (item.id === "b") throw new Error("worker stopped");
        report(item.id, { result: fakeResult(item.id), seconds: 0 });
      }
    };
    const rows = await evaluate(stubCases(["a", "b", "c", "d"]), { concurrency: 3, real: false, checks: noChecks, runGroup, chains: [["a", "b", "c"]] });
    expect(rows.map((row) => [row.id, row.verdict])).toEqual([["a", "pass"], ["b", "fail"], ["c", "fail"], ["d", "pass"]]);
    expect(rows[1].failed).toEqual([{ name: "run", pass: false, detail: "worker stopped" }]);
  });
});
