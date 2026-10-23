import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDone, listRuns, parseTrace, readTrace, reviewQueue, summarise } from "./trace-read";
import type { TraceLine } from "./trace";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-trace-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const line = (extra: Partial<TraceLine>): TraceLine => ({
  timestamp: "2026-10-01T10:00:00.000Z",
  run_id: "r",
  agent_name: "Planner",
  action: "plan",
  input_summary: "",
  output_summary: "",
  target_agent: null,
  model: null,
  confidence: null,
  retry_count: 0,
  status: "ok",
  ...extra,
});
const runEnd = (runId: string, at: string, extra: Partial<TraceLine>): TraceLine =>
  line({ run_id: runId, timestamp: at, task: "pre_trade", agent_name: "Orchestrator", action: "run_end", input_summary: "task=pre_trade as_of=2026-10-01 sample_mode=true", output_summary: "status=needs_human", status: "needs_human", ...extra });

async function write(runId: string, lines: TraceLine[], mtime?: Date): Promise<void> {
  const file = path.join(dir, `trace-${runId}.jsonl`);
  await writeFile(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  if (mtime !== undefined) await utimes(file, mtime, mtime);
}

describe("readTrace", () => {
  it.each(["../etc", "..", "a/b", "a\\b", ".hidden", "", "x".repeat(81), "a b"])("rejects the run id %j before any file is read", async (runId) => {
    const read = vi.fn();
    const result = await readTrace(runId, { dir, read });
    expect(result).toMatchObject({ ok: false, status: 400, type: "InvalidInput" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the lines of a run in file order, skipping a line that is still being written", async () => {
    await writeFile(path.join(dir, "trace-example_x.jsonl"), `${JSON.stringify(line({ action: "a" }))}\n${JSON.stringify(line({ action: "b" }))}\n{"agent_name": "Pla`);
    const result = await readTrace("example_x", { dir });
    expect(result.ok && result.lines.map((entry) => entry.action)).toEqual(["a", "b"]);
  });

  it("answers 404 for a run with no file and 500 for any other read failure", async () => {
    expect(await readTrace("nope", { dir })).toMatchObject({ ok: false, status: 404, type: "NotFound" });
    const broken = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(await readTrace("nope", { dir, read: broken })).toMatchObject({ ok: false, status: 500, type: "Internal" });
  });
});

describe("isDone and parseTrace", () => {
  it("is done on the run_end line or an error line only", () => {
    expect(isDone([])).toBe(false);
    expect(isDone([line({})])).toBe(false);
    expect(isDone([line({}), runEnd("r", "2026-10-01T10:01:00.000Z", {})])).toBe(true);
    expect(isDone([line({ status: "error" })])).toBe(true);
    expect(parseTrace("\n\nnot json\n")).toEqual([]);
  });
});

describe("the review queue", () => {
  it("lists only needs_human runs, newest first, with the stop reason or escalation rule from the run_end line", async () => {
    await write("old_escalated", [line({ run_id: "old_escalated" }), runEnd("old_escalated", "2026-10-01T09:00:00.000Z", { escalation_rule: "sector_target" })]);
    await write("new_limit", [runEnd("new_limit", "2026-10-02T09:00:00.000Z", { task: "explain_week", stop_reason: "rounds", why: "rounds" })]);
    await write("fine", [runEnd("fine", "2026-10-03T09:00:00.000Z", { status: "ok", output_summary: "status=success" })]);
    await write("broken", [runEnd("broken", "2026-10-03T10:00:00.000Z", { status: "error" })]);
    await write("still_running", [line({ run_id: "still_running", timestamp: "2026-10-04T09:00:00.000Z" })]);
    await writeFile(path.join(dir, "notes.txt"), "not a trace");

    const queue = await reviewQueue(dir);
    expect(queue.map((run) => run.run_id)).toEqual(["new_limit", "old_escalated"]);
    expect(queue[0]).toMatchObject({ task: "explain_week", stop_reason: "rounds", escalation_rule: null, as_of: "2026-10-01" });
    expect(queue[1]).toMatchObject({ task: "pre_trade", stop_reason: null, escalation_rule: "sector_target" });

    const all = await listRuns(dir);
    expect(Object.fromEntries(all.map((run) => [run.run_id, run.status]))).toEqual({ new_limit: "needs_human", old_escalated: "needs_human", fine: "success", broken: "error", still_running: "running" });
  });

  it("lists a run the owner stopped, with stop_reason cancelled from its last line", async () => {
    await write("stopped", [line({ run_id: "stopped", agent_name: "Orchestrator", action: "cancelled", status: "needs_human", why: "cancelled by the owner" }), runEnd("stopped", "2026-10-01T10:05:00.000Z", { task: "explain_week", stop_reason: "cancelled", output_summary: "status=needs_human stop_reason=cancelled" })]);
    const queue = await reviewQueue(dir);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ run_id: "stopped", status: "needs_human", stop_reason: "cancelled", escalation_rule: null });
  });

  it("is empty for a directory that does not exist", async () => {
    expect(await listRuns(path.join(dir, "missing"))).toEqual([]);
  });

  it("reads the final status from the run_end line, not from an earlier needs_human line", () => {
    const summary = summarise("r", [line({ status: "needs_human", action: "stop" }), runEnd("r", "2026-10-01T10:00:00.000Z", { status: "ok" })]);
    expect(summary.status).toBe("success");
  });
});
