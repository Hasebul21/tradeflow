import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DISCLAIMER } from "./agents/writer";
import { openMemory } from "./memory";
import type { RunResult } from "./orchestrator";
import { runRequest } from "./request";
import type { TraceLine } from "./trace";

// A5: the owner corrects the 24 Sep review, and the 1 Oct review recalls the correction by tag. Sample mode, on a
// copy of data/ through TRADEFLOW_DATA_DIR, so memory and the World Model never touch data/.
let dir: string;
const runIds: string[] = [];
let review0924: RunResult;
let feedback: RunResult;
let review1001: RunResult;

const CORRECTION = "Compare each holding with its sector index before DSEX.";

async function post(runId: string, input: Record<string, unknown>): Promise<RunResult> {
  runIds.push(runId);
  return runRequest({ run_id: runId, input, options: { sample_mode: true } });
}

const traceOf = (runId: string): TraceLine[] =>
  readFileSync(path.resolve("logs", `trace-${runId}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceLine);

const COUNTERS = ["model_calls", "query_calls", "tokens_in", "tokens_out"] as const;
const sumUsage = (lines: TraceLine[]) =>
  Object.fromEntries(COUNTERS.map((key) => [key, lines.reduce((n, line) => n + (line.usage?.[key] ?? 0), 0)]));

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-corrections-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  process.env.SAMPLE_MODE = "true";

  review0924 = await post("review-0924", { task: "explain_week", question: "Why did my portfolio move this week?", as_of: "2026-09-24" });
  feedback = await post("feedback-0924", { task: "feedback", review_run_id: "review-0924", text: CORRECTION });
  review1001 = await post("review-1001", { task: "explain_week", question: "Why did my portfolio move this week?", as_of: "2026-10-01" });
}, 60_000);

afterAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  delete process.env.SAMPLE_MODE;
  await rm(dir, { recursive: true, force: true });
  for (const runId of runIds) await rm(path.resolve("logs", `trace-${runId}.jsonl`), { force: true });
});

describe("learning from a correction", () => {
  it("recalls the correction by tag on 1 Oct, applies it and says so in What I remembered", () => {
    expect(review0924.status).toBe("success");
    expect(review1001.status).toBe("success");
    const output = review1001.output!;
    const correction = output.memories_recalled.find((memory) => memory.tags.includes("correction"));
    expect(correction).toBeDefined();
    expect(feedback.output?.memory_ids_added).toContain(correction!.id);

    const recallLine = traceOf("review-1001").find((line) => line.agent_name === "Memory" && line.action === "recall")!;
    const byTag = /by_tag=([^;]*)/.exec(recallLine.output_summary)![1].split(",");
    expect(byTag).toContain(correction!.id);

    expect(output.applied_corrections).toContainEqual({ id: correction!.id, content: CORRECTION });

    const markdown = output.review_markdown;
    const section = markdown.slice(markdown.indexOf("**What I remembered**"));
    expect(markdown).toContain("**What I remembered**");
    expect(section).toMatch(/correction/i);
    expect(section).toContain(CORRECTION);

    // The sample Analyst puts the sector finding first and says the correction was applied.
    expect(output.findings[0].kind).toBe("sector");
    expect(output.findings[0].claim).toMatch(/Applying your correction/);
    expect(output.findings[0].memory_ids).toContain(correction!.id);
  });

  it("stores the feedback with no Planner: success and the memory ids added", () => {
    expect(feedback.status).toBe("success");
    expect(feedback.output?.memory_ids_added?.length).toBeGreaterThan(0);
    // Every review ends with the disclaimer line, the feedback acknowledgement too.
    expect(feedback.output?.review_markdown.trimEnd().split("\n").at(-1)).toBe(DISCLAIMER);
    const lines = traceOf("feedback-0924");
    expect(lines.some((line) => line.agent_name === "Planner")).toBe(false);
    // The miner's model call, and one Memory learn line per id added.
    expect(lines.some((line) => line.agent_name === "Memory" && line.action === "model_call")).toBe(true);
    for (const id of feedback.output!.memory_ids_added!) {
      expect(lines.some((line) => line.agent_name === "Memory" && line.action === "learn" && line.output_summary.includes(`memoryId=${id};`))).toBe(true);
    }
  });

  it("ends the feedback trace with the Orchestrator's run_end line, whose usage is the result's and the other lines' sum", () => {
    const lines = traceOf("feedback-0924");
    const last = lines.at(-1)!;
    expect(last.agent_name).toBe("Orchestrator");
    expect(last.action).toBe("run_end");
    expect(last.usage).toEqual(feedback.usage);
    expect(sumUsage(lines.slice(0, -1))).toEqual(Object.fromEntries(COUNTERS.map((key) => [key, feedback.usage[key]])));
    expect(feedback.usage.model_calls).toBe(1);
  });

  it("sends hmem.feedback(id, \"wrong\") once for the 24 Sep review named in wrong_memory_ids, and traces it", async () => {
    const hmem = openMemory();
    const reviewId = hmem.store.all().find((memory) => memory.tags.includes("review") && memory.tags.includes("run:review-0924"))!.id;
    const spy = vi.spyOn(hmem, "feedback");
    const result = await post("feedback-wrong", {
      task: "feedback",
      review_run_id: "review-0924",
      text: "The review should name the sector index first.",
      wrong_memory_ids: [reviewId],
    });
    // Read the calls before mockRestore, which clears them.
    const calls = [...spy.mock.calls];
    spy.mockRestore();
    expect(result.status).toBe("success");
    expect(calls).toEqual([[reviewId, "wrong"]]);
    const line = traceOf("feedback-wrong").find((l) => l.agent_name === "Memory" && l.action === "feedback");
    expect(line?.output_summary).toContain(reviewId);
  });

  it("refuses feedback for a review run id no memory has", async () => {
    const result = await post("feedback-unknown", { task: "feedback", review_run_id: "no-such-run", text: CORRECTION });
    expect(result.status).toBe("error");
    expect(result.error?.type).toBe("InvalidInput");
    expect(result.error?.message).toContain("no-such-run");
  });
});
