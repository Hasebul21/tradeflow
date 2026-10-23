import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import type { CompleteOptions, CompleteResult } from "./llm";
import { run } from "./orchestrator";
import { active, cancel } from "./registry";
import type { TraceLine } from "./trace";

// The sample model waits 2 s on every call and rejects with an AbortError as soon as the signal it was given aborts.
// llm.ts passes options.signal to it, as it passes the signal to the openai client on the real path.
const stubs = vi.hoisted(() => ({ slow: false }));
vi.mock("./sample-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sample-model")>();
  const complete = async (options: CompleteOptions): Promise<CompleteResult> => {
    if (!stubs.slow) return actual.complete(options);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("This operation was aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 2000);
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return actual.complete(options);
  };
  return { ...actual, complete };
});

const config = loadConfig({ SAMPLE_MODE: "true", LOG_LEVEL: "error" }, () => {});
const AS_OF = "2026-10-01";
const QUESTION = "Why did my portfolio move this week?";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
const traces: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-cancel-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  stubs.slow = true;
});
afterEach(async () => {
  stubs.slow = false;
  delete process.env.TRADEFLOW_DATA_DIR;
  for (const id of traces.splice(0)) rmSync(path.resolve("logs", `trace-${id}.jsonl`), { force: true });
  await rm(dir, { recursive: true, force: true });
});

const traceOf = (id: string): TraceLine[] =>
  readFileSync(path.resolve("logs", `trace-${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceLine);

/** Every file under the temporary data dir's memory folder, as one string. */
function memoryText(): string {
  const root = path.join(dir, "memory");
  if (!existsSync(root)) return "";
  const walk = (folder: string): string[] => readdirSync(folder).flatMap((name) => (statSync(path.join(folder, name)).isDirectory() ? walk(path.join(folder, name)) : [readFileSync(path.join(folder, name), "utf8")]));
  return walk(root).join("\n");
}

describe("cancelling a run", () => {
  it("a slow explain_week cancelled after 300 ms returns within 1 s, needs_human, cancelled, with a complete trace and no memory", async () => {
    const runId = "cancel-week";
    traces.push(runId);
    const running = run({ runId, task: "explain_week", input: { question: QUESTION, as_of: AS_OF }, sampleMode: true, config });
    await sleep(300);
    expect(active().map((entry) => entry.run_id)).toContain(runId);
    const cancelledAt = Date.now();
    expect(cancel(runId)).toBe(true);
    const result = await running;
    const took = Date.now() - cancelledAt;
    console.info(`cancel-week returned ${took} ms after the cancel`);

    expect(took).toBeLessThan(1000);
    expect(result.status).toBe("needs_human");
    expect(result.output?.stop_reason).toBe("cancelled");
    expect(result.output?.partial).toBe(true);
    expect(result.usage.model_calls).toBeLessThanOrEqual(1);
    expect(result.error).toBeNull();

    const lines = traceOf(runId);
    const cancelled = lines.filter((line) => line.agent_name === "Orchestrator" && line.action === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].why).toBe("cancelled by the owner");
    const last = lines.at(-1);
    expect(last).toMatchObject({ agent_name: "Orchestrator", action: "run_end", stop_reason: "cancelled" });
    expect(last?.usage).toBeDefined();
    expect(last?.usage?.model_calls).toBe(result.usage.model_calls);

    expect(memoryText()).not.toContain(`run:${runId}`);
    expect(active()).toEqual([]);
  });

  it("a cancelled briefing cancels the children that started, skips the rest, and leaves the registry empty", async () => {
    const runId = "cancel-brief";
    traces.push(runId, `${runId}-1-explain_week`, `${runId}-2-thesis_check`, `${runId}-3-reconcile`);
    const running = run({ runId, task: "briefing", input: { as_of: AS_OF }, sampleMode: true, config });
    // Wait until the first two children (MAX_CONCURRENT_CHILDREN is 2) are running, then let them reach the slow model.
    const deadline = Date.now() + 5000;
    while (active().filter((entry) => entry.parent_run_id === runId).length < 2 && Date.now() < deadline) await sleep(10);
    await sleep(300);
    expect(active().filter((entry) => entry.parent_run_id === runId)).toHaveLength(2);
    // The briefing is the only top-level entry: its children never count against MAX_CONCURRENT_RUNS.
    expect(active().filter((entry) => entry.parent_run_id === null).map((entry) => entry.run_id)).toEqual([runId]);

    const cancelledAt = Date.now();
    expect(cancel(runId)).toBe(true);
    const result = await running;
    console.info(`cancel-brief returned ${Date.now() - cancelledAt} ms after the cancel`);

    expect(result.status).toBe("needs_human");
    expect(result.output?.partial).toBe(true);
    expect(result.output?.stop_reason).toBe("cancelled");
    const sections = result.output?.sections ?? [];
    expect(sections).toHaveLength(3);
    for (const section of sections.slice(0, 2)) {
      expect(section.status).toBe("needs_human");
      expect(section.stop_reason).toBe("cancelled");
    }
    expect(sections[2]).toMatchObject({ task: "reconcile", status: "skipped", stop_reason: "cancelled" });

    // A started child has its own complete trace; a skipped one has none.
    for (const child of sections.slice(0, 2)) {
      const lines = traceOf(child.run_id);
      expect(lines.some((line) => line.agent_name === "Orchestrator" && line.action === "cancelled")).toBe(true);
      expect(lines.at(-1)).toMatchObject({ agent_name: "Orchestrator", action: "run_end", stop_reason: "cancelled" });
    }
    expect(existsSync(path.resolve("logs", `trace-${runId}-3-reconcile.jsonl`))).toBe(false);
    const parent = traceOf(runId);
    expect(parent.filter((line) => line.action === "cancelled")).toHaveLength(1);
    expect(parent.filter((line) => line.action === "child_skipped").map((line) => line.why)).toEqual(["cancelled by the owner"]);
    expect(parent.at(-1)).toMatchObject({ agent_name: "Orchestrator", action: "run_end", stop_reason: "cancelled" });

    expect(active()).toEqual([]);
    expect(memoryText()).not.toContain(`run:${runId}`);
  });
});
