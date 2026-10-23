import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_RUNS, metricRows, metricsFromTraces, metricsPayload, promptVersionRows, readRuns, runLimit, type RunLines } from "./metrics";
import type { TraceLine } from "./trace";

// Made-up runs: each is the array of trace lines of one run.
let clock = 0;
const line = (runId: string, task: string | undefined, fields: Partial<TraceLine> & Pick<TraceLine, "agent_name" | "action">): TraceLine => ({
  timestamp: new Date(Date.UTC(2026, 9, 1, 8, 0, clock++)).toISOString(),
  run_id: runId,
  ...(task === undefined ? {} : { task }),
  input_summary: "in",
  output_summary: "out",
  target_agent: null,
  model: null,
  confidence: null,
  retry_count: 0,
  status: "ok",
  ...fields,
});

type End = { status: "ok" | "needs_human" | "error"; stop_reason?: string; duration_ms: number; model_calls?: number; query_calls?: number; tokens_in?: number; tokens_out?: number };

function makeRun(runId: string, task: string, rounds: { reject: boolean }[], end: End, extra: TraceLine[] = []): TraceLine[] {
  const lines: TraceLine[] = [];
  rounds.forEach((round, index) => {
    lines.push(line(runId, task, { agent_name: "Evaluator", action: round.reject ? "reject" : "accept", retry_count: index, status: round.reject ? "rejected" : "accepted", confidence: round.reject ? 0.67 : 1 }));
  });
  lines.push(...extra);
  lines.push(
    line(runId, task, {
      agent_name: "Orchestrator",
      action: "run_end",
      status: end.status,
      retry_count: Math.max(0, rounds.length - 1),
      ...(end.stop_reason === undefined ? {} : { stop_reason: end.stop_reason }),
      usage: { model_calls: end.model_calls ?? 4, query_calls: end.query_calls ?? 5, tokens_in: end.tokens_in ?? 100, tokens_out: end.tokens_out ?? 50, duration_ms: end.duration_ms },
    }),
  );
  return lines;
}

const query = (runId: string, task: string, source: "zetaris" | "local" | "local-fallback") => line(runId, task, { agent_name: "Query", action: "query", source });

/** Five runs, durations 1000 to 5000 ms. */
const fixture = (): RunLines[] => [
  // explain_week: accepted in round 2 after one reject
  makeRun("w1", "explain_week", [{ reject: true }, { reject: false }], { status: "ok", duration_ms: 1000, model_calls: 6, query_calls: 5, tokens_in: 200, tokens_out: 100 }, [query("w1", "explain_week", "zetaris"), query("w1", "explain_week", "local")]),
  // explain_week: needs_human after three rejects
  makeRun("w2", "explain_week", [{ reject: true }, { reject: true }, { reject: true }], { status: "needs_human", stop_reason: "rounds", duration_ms: 2000, model_calls: 8, query_calls: 6, tokens_in: 400, tokens_out: 200 }, [query("w2", "explain_week", "local-fallback")]),
  // explain_week: success in round 1
  makeRun("w3", "explain_week", [{ reject: false }], { status: "ok", duration_ms: 3000, model_calls: 4, query_calls: 4, tokens_in: 100, tokens_out: 50 }),
  // thesis_check: success
  makeRun("t1", "thesis_check", [{ reject: false }], { status: "ok", duration_ms: 4000 }),
  // pre_trade: needs_human with no stop_reason
  makeRun("p1", "pre_trade", [{ reject: false }], { status: "needs_human", duration_ms: 5000 }),
];

describe("metricsFromTraces", () => {
  it("counts the five-run fixture: statuses, rounds, rejection rate and nearest-rank percentiles", () => {
    const metrics = metricsFromTraces(fixture());
    expect(Object.keys(metrics)).toEqual([ALL_RUNS, "explain_week", "thesis_check", "pre_trade"]);

    const week = metrics.explain_week;
    expect(week.runs).toBe(3);
    expect(week.by_status).toEqual({ success: 2, needs_human: 1, error: 0, unknown: 0 });
    expect(week.by_stop_reason).toEqual({ rounds: 1 });
    expect(week.rounds).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(week.rejection_rate).toBe(2 / 3);
    expect(week.avg_model_calls).toBe(6);
    expect(week.avg_query_calls).toBe(5);
    expect(week.avg_tokens).toBe((300 + 600 + 150) / 3);
    expect(week.duration_ms).toEqual({ p50: 2000, p95: 3000 });
    expect(week.queries).toEqual({ zetaris: 1, local: 1, local_fallback: 1 });

    const all = metrics.all;
    expect(all.runs).toBe(5);
    expect(all.duration_ms).toEqual({ p50: 3000, p95: 5000 });
    expect(all.by_status).toEqual({ success: 3, needs_human: 2, error: 0, unknown: 0 });
    expect(all.by_stop_reason).toEqual({ rounds: 1 });
    expect(all.rejection_rate).toBe(2 / 5);
    expect(metrics.pre_trade.by_status.needs_human).toBe(1);
    expect(metrics.pre_trade.by_stop_reason).toEqual({});
    expect(metrics.thesis_check.by_status.success).toBe(1);
  });

  it("gives zero counts and zero rates for an empty list", () => {
    const metrics = metricsFromTraces([]);
    expect(Object.keys(metrics)).toEqual([ALL_RUNS]);
    expect(metrics.all).toEqual({
      runs: 0,
      by_status: { success: 0, needs_human: 0, error: 0, unknown: 0 },
      by_stop_reason: {},
      rounds: { 1: 0, 2: 0, 3: 0 },
      rejection_rate: 0,
      avg_model_calls: 0,
      avg_query_calls: 0,
      avg_tokens: 0,
      duration_ms: { p50: 0, p95: 0 },
      queries: { zetaris: 0, local: 0, local_fallback: 0 },
      guards: { checked: 0, blocked: 0, injections_flagged: 0, advice_declined: 0 },
      strong_to_main_fallbacks: 0,
      memories: { recalled: 0, by_tag: 0 },
      prompt_versions: {},
    });
  });

  it("counts a run with no run_end line as unknown status, with no duration and no usage", () => {
    const running = [line("r1", "explain_week", { agent_name: "Planner", action: "plan" })];
    const m = metricsFromTraces([running, ...fixture()]).explain_week;
    expect(m.runs).toBe(4);
    expect(m.by_status.unknown).toBe(1);
    // The averages and percentiles come only from the three runs that have a run_end line.
    expect(m.avg_model_calls).toBe(6);
    expect(m.duration_ms).toEqual({ p50: 2000, p95: 3000 });
  });

  it("puts a trace from before the task was written under unknown, and counts a fourth round under its own key", () => {
    const old = makeRun("old", "x", [{ reject: true }, { reject: true }, { reject: true }, { reject: false }], { status: "ok", duration_ms: 10 }).map((l) => Object.fromEntries(Object.entries(l).filter(([key]) => key !== "task")) as TraceLine);
    const metrics = metricsFromTraces([old]);
    expect(Object.keys(metrics)).toEqual([ALL_RUNS, "unknown"]);
    expect(metrics.unknown.rounds).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1 });
  });

  it("takes its query, guard, fallback and memory counts from proofFromTrace", () => {
    const extra = [
      line("g1", "explain_week", { agent_name: "Guard", action: "allow" }),
      line("g1", "explain_week", { agent_name: "Guard", action: "block" }),
      line("g1", "explain_week", { agent_name: "Guard", action: "injection_flagged" }),
      line("g1", "explain_week", { agent_name: "Guard", action: "advice_declined" }),
      line("g1", "explain_week", { agent_name: "Planner", action: "model_call", model: "m", fallback: "strong->main" }),
      line("g1", "explain_week", { agent_name: "Memory", action: "recall", output_summary: "by_tag=mem-1,mem-2; by_query=mem-3" }),
    ];
    const m = metricsFromTraces([makeRun("g1", "explain_week", [{ reject: false }], { status: "ok", duration_ms: 1 }, extra)]).all;
    expect(m.guards).toEqual({ checked: 2, blocked: 1, injections_flagged: 1, advice_declined: 1 });
    expect(m.strong_to_main_fallbacks).toBe(1);
    expect(m.memories).toEqual({ recalled: 3, by_tag: 2 });
  });

  it("lists each Analyst prompt version with the runs that used it", () => {
    const withHash = (runId: string, hash: string) =>
      makeRun(runId, "explain_week", [{ reject: false }], { status: "ok", duration_ms: 1 }, [
        line(runId, "explain_week", { agent_name: "Analyst", action: "model_call", prompt_hash: hash }),
        // A second Analyst call in the same run counts the run once.
        line(runId, "explain_week", { agent_name: "Analyst", action: "model_call", prompt_hash: hash }),
        // The Memory miner loads no prompt file: no hash, no entry.
        line(runId, "explain_week", { agent_name: "Memory", action: "model_call" }),
      ]);
    const metrics = metricsFromTraces([withHash("a", "aaaaaaaa"), withHash("b", "bbbbbbbb")]);
    expect(metrics.all.prompt_versions).toEqual({
      Analyst: [
        { prompt_hash: "aaaaaaaa", runs: 1 },
        { prompt_hash: "bbbbbbbb", runs: 1 },
      ],
    });
    expect(promptVersionRows(metrics.all)).toEqual([
      { agent: "Analyst", prompt_hash: "aaaaaaaa", runs: 1 },
      { agent: "Analyst", prompt_hash: "bbbbbbbb", runs: 1 },
    ]);
  });
});

describe("the output of the numbers", () => {
  it("builds one flat payload: runs read, newest and oldest timestamps, then all and each task", () => {
    const payload = metricsPayload(fixture());
    expect(payload.runs_read).toBe(5);
    expect(typeof payload.newest).toBe("string");
    expect((payload.oldest as string) <= (payload.newest as string)).toBe(true);
    expect(Object.keys(payload)).toEqual(["runs_read", "newest", "oldest", ALL_RUNS, "explain_week", "thesis_check", "pre_trade"]);
    expect(metricsPayload([])).toMatchObject({ runs_read: 0, newest: null, oldest: null });
  });

  it("writes the same rows the page shows", () => {
    const rows = Object.fromEntries(metricRows(metricsFromTraces(fixture()).explain_week));
    expect(rows["Runs"]).toBe("3");
    expect(rows["Rejection rate"]).toBe("66.7%");
    expect(rows["Rounds"]).toBe("1 1, 2 1, 3 1");
    expect(rows["Duration p50 / p95"]).toBe("2.0 s / 3.0 s");
  });

  it("keeps the limit between 1 and 1000 and defaults to 200", () => {
    expect([runLimit(null), runLimit(undefined), runLimit(""), runLimit("abc"), runLimit("0"), runLimit("-4"), runLimit("2.5")]).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect([runLimit("5"), runLimit("1000"), runLimit("5000")]).toEqual([5, 1000, 1000]);
  });
});

describe("readRuns", () => {
  it("reads the newest trace files first, at most `limit`, and never any other file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tradeflow-metrics-"));
    try {
      const names = ["trace-old.jsonl", "trace-mid.jsonl", "trace-new.jsonl", "other.jsonl"];
      const base = Date.now() / 1000 - 100;
      for (const [index, name] of names.entries()) {
        const runId = name.replace(/^trace-|\.jsonl$/g, "");
        await writeFile(path.join(dir, name), `${JSON.stringify(line(runId, "explain_week", { agent_name: "Planner", action: "plan" }))}\n`);
        // 10 ms apart; other.jsonl is the newest file of all and still must not be read.
        await utimes(path.join(dir, name), base + index * 0.01, base + index * 0.01);
      }
      await writeFile(path.join(dir, "trace-empty.jsonl"), "");
      await utimes(path.join(dir, "trace-empty.jsonl"), base - 50, base - 50);

      const two = await readRuns(dir, 2);
      expect(two.map((lines) => lines[0].run_id)).toEqual(["new", "mid"]);
      const all = await readRuns(dir);
      // The empty file is not a run; other.jsonl does not match the name pattern.
      expect(all.map((lines) => lines[0].run_id)).toEqual(["new", "mid", "old"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns no runs for a directory that does not exist", async () => {
    expect(await readRuns(path.join(tmpdir(), "tradeflow-no-such-dir-metrics"))).toEqual([]);
  });
});
