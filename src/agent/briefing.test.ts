import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stepRows } from "@/app/explain/trace-steps";
import { DISCLAIMER } from "./agents/writer";
import { BRIEFING_MIN_CHILD_MS, loadConfig } from "./config";
import { briefing, run, type RunChild, type RunResult } from "./orchestrator";
import type { TraceLine } from "./trace";

// The briefing as of 2026-10-01 with the sample model, on a temporary copy of data/ through TRADEFLOW_DATA_DIR so memory
// and the ledger never touch data/. Each child is a whole run with its own trace file in logs/.
const config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const ORDER = ["explain_week", "thesis_check", "reconcile"];
const HEADINGS = ["## What moved", "## Your theses", "## Ledger and broker differences"];

const traceOf = (runId: string): TraceLine[] =>
  readFileSync(path.resolve("logs", `trace-${runId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);

let dir: string;
let main: RunResult;
const savedDir = process.env.TRADEFLOW_DATA_DIR;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-briefing-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  main = await run({ runId: "briefing-main", task: "briefing", input: { as_of: AS_OF }, sampleMode: true, config });
}, 120_000);

afterAll(async () => {
  if (savedDir === undefined) delete process.env.TRADEFLOW_DATA_DIR;
  else process.env.TRADEFLOW_DATA_DIR = savedDir;
  await rm(dir, { recursive: true, force: true });
});

describe("briefing", () => {
  it("chains explain_week, thesis_check and reconcile and adds up their usage", () => {
    expect(main.status).toBe("success");
    expect(main.task).toBe("briefing");
    const sections = main.output!.sections!;
    expect(sections.map((section) => section.task)).toEqual(ORDER);
    expect(sections.map((section) => section.run_id)).toEqual(["briefing-main-1-explain_week", "briefing-main-2-thesis_check", "briefing-main-3-reconcile"]);
    expect(sections.map((section) => section.status)).toEqual(["success", "success", "needs_human"]);
    expect(sections[2].stop_reason).toBeNull();
    expect(main.output).toMatchObject({ partial: false, stop_reason: null });
    expect(sections.every((section) => section.usage.model_calls > 0)).toBe(true);
    expect(main.usage.model_calls).toBe(sections.reduce((sum, section) => sum + section.usage.model_calls, 0));
    expect(main.usage.query_calls).toBe(sections.reduce((sum, section) => sum + section.usage.query_calls, 0));
    expect(main.usage.tokens_in).toBe(sections.reduce((sum, section) => sum + section.usage.tokens_in, 0));
  });

  it("writes one fixed_plan line, three handoff lines in order with an existing child trace each, and a run_end line", () => {
    const lines = traceOf("briefing-main");
    const orchestrator = lines.filter((line) => line.agent_name === "Orchestrator");
    expect(orchestrator.map((line) => line.action)).toEqual(["fixed_plan", "handoff", "handoff", "handoff", "run_end"]);
    expect(lines[lines.length - 1]).toMatchObject({ agent_name: "Orchestrator", action: "run_end", usage: expect.objectContaining({ model_calls: main.usage.model_calls }) });
    expect(orchestrator[0].why).toContain("1. explain_week:");
    expect(orchestrator[0].why).toContain("3. reconcile:");
    const handoffs = orchestrator.filter((line) => line.action === "handoff");
    expect(handoffs.map((line) => line.target_agent)).toEqual(ORDER);
    expect(handoffs.map((line) => line.child_run_id)).toEqual(main.output!.sections!.map((section) => section.run_id));
    for (const handoff of handoffs) {
      expect(existsSync(path.resolve("logs", `trace-${handoff.child_run_id}.jsonl`))).toBe(true);
      expect(handoff.output_summary).toMatch(/^status=(success|needs_human)/);
    }
    // Only handoff lines carry child_run_id.
    expect(lines.filter((line) => line.child_run_id !== undefined)).toHaveLength(3);
    // The lines other than run_end add up to the run's usage, as for every run.
    const sum = lines.slice(0, -1).reduce((total, line) => total + (line.usage?.model_calls ?? 0), 0);
    expect(sum).toBe(main.usage.model_calls);
    // The parent makes no model call of its own.
    expect(lines.some((line) => line.model !== null)).toBe(false);
  });

  it("ends with the disclaimer once, keeps the three headings in order and cites only entries it holds", () => {
    const text = main.output!.review_markdown;
    expect(text.split(DISCLAIMER)).toHaveLength(2);
    expect(text.trimEnd().split("\n").pop()).toBe(DISCLAIMER);
    expect(text.startsWith(`# Weekly briefing for ${AS_OF}`)).toBe(true);
    const at = HEADINGS.map((heading) => text.indexOf(heading));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const cited = [...text.matchAll(/\[q:([^\]]+)\]/g)].map((match) => match[1]);
    expect(cited.length).toBeGreaterThan(0);
    const known = new Map(main.output!.citations.map((citation) => [citation.run_query_id, citation.child_run_id]));
    for (const id of cited) expect(known.has(id)).toBe(true);
    expect(main.output!.citations.every((citation) => citation.child_run_id?.startsWith("briefing-main-"))).toBe(true);
    expect(text).not.toContain("Not covered: explain_week");
  });

  it("keeps the other sections when one child stops, and says what was not covered", async () => {
    const stub: RunChild = async (options) => {
      if (options.task !== "reconcile") return run(options);
      const usage = { model_calls: 2, query_calls: 1, tokens_in: 10, tokens_out: 5, duration_ms: 1 };
      return {
        run_id: options.runId,
        task: "reconcile",
        status: "needs_human",
        output: { summary: "stopped", review_markdown: `stopped\n\n${DISCLAIMER}`, findings: [], gaps: [], citations: [], needs_human: true, declined_advice: false, injection_seen: false, memories_recalled: [], applied_corrections: [], rounds: 3, scores: null, model_source: "sample-model", partial: true, stop_reason: "rounds" },
        error: null,
        agents: [],
        usage,
        trace_id: options.runId,
        log_file: null,
        execution_time_seconds: 0,
      };
    };
    const result = await briefing({ runId: "briefing-stub", input: { as_of: AS_OF }, sampleMode: true, config }, stub);
    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ partial: true, stop_reason: "rounds" });
    expect(result.output!.sections!.map((section) => section.status)).toEqual(["success", "success", "needs_human"]);
    const text = result.output!.review_markdown;
    expect(text).toContain("Not covered: reconcile stopped (rounds); its trace is briefing-stub-3-reconcile.");
    expect(text).toContain(HEADINGS[0]);
    expect(text.split(DISCLAIMER)).toHaveLength(2);
    expect(result.usage.model_calls).toBeGreaterThan(2);
  }, 120_000);

  it("turns a child that throws into an error section and still finishes", async () => {
    const stub: RunChild = async (options) => {
      if (options.task === "thesis_check") throw new Error("boom");
      return run(options);
    };
    const result = await briefing({ runId: "briefing-throw", input: { as_of: AS_OF }, sampleMode: true, config }, stub);
    expect(result.status).toBe("needs_human");
    expect(result.output!.sections!.map((section) => section.status)).toEqual(["success", "error", "needs_human"]);
    expect(result.output!.review_markdown).toContain("Not covered: thesis_check stopped (error); its trace is briefing-throw-2-thesis_check.");
    expect(result.output!.partial).toBe(true);
  }, 120_000);

  it("gives each child the time left: its RUN_TIMEOUT_MS is the smaller of its own and what remains", async () => {
    const seen: number[] = [];
    const spy: RunChild = async (options) => {
      seen.push(options.config!.RUN_TIMEOUT_MS);
      return run(options);
    };
    const limited = loadConfig({ SAMPLE_MODE: "true", BRIEFING_TIMEOUT_MS: "60000" }, () => {});
    await briefing({ runId: "briefing-left", input: { as_of: AS_OF }, sampleMode: true, config: limited }, spy);
    expect(seen).toHaveLength(3);
    expect(seen.every((value) => value <= 60000 && value >= BRIEFING_MIN_CHILD_MS)).toBe(true);
    expect(seen[0]).toBeGreaterThanOrEqual(seen[2]);
    // With plenty of time a child keeps its own limit.
    const roomy: number[] = [];
    await briefing({ runId: "briefing-roomy", input: { as_of: AS_OF }, sampleMode: true, config: loadConfig({ SAMPLE_MODE: "true", RUN_TIMEOUT_MS: "30000" }, () => {}) }, async (options) => {
      roomy.push(options.config!.RUN_TIMEOUT_MS);
      return run(options);
    });
    expect(roomy).toEqual([30000, 30000, 30000]);
  }, 240_000);

  it("skips every child when BRIEFING_TIMEOUT_MS leaves less than the minimum, with zero model calls", async () => {
    const spy = vi.fn<RunChild>();
    const started = Date.now();
    const result = await briefing({ runId: "briefing-timeout", input: { as_of: AS_OF }, sampleMode: true, config: loadConfig({ SAMPLE_MODE: "true", BRIEFING_TIMEOUT_MS: "1" }, () => {}) }, spy);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ partial: true, stop_reason: "run_timeout" });
    expect(result.output!.sections!.map((section) => [section.task, section.status, section.stop_reason])).toEqual(ORDER.map((task) => [task, "skipped", "run_timeout"]));
    expect(result.usage.model_calls).toBe(0);
    expect(result.output!.review_markdown).toContain("Not covered: reconcile stopped (run_timeout)");
    expect(result.output!.review_markdown.trimEnd().split("\n").pop()).toBe(DISCLAIMER);
    const lines = traceOf("briefing-timeout");
    expect(lines.filter((line) => line.action === "child_skipped")).toHaveLength(3);
    expect(lines[lines.length - 1]).toMatchObject({ action: "run_end", status: "needs_human", stop_reason: "run_timeout" });
  });

  it.each(["not-a-date", "1999-01-01", "2099-01-01"])("refuses the date %s as InvalidInput before any child starts", async (date) => {
    const runId = `briefing-bad-${date.slice(0, 4)}`;
    const spy = vi.fn<RunChild>();
    const result = await briefing({ runId, input: { as_of: date }, sampleMode: true, config }, spy);
    expect(result).toMatchObject({ status: "error", error: { type: "InvalidInput", recoverable: false }, usage: { model_calls: 0 } });
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(path.resolve("logs", `trace-${runId}-1-explain_week.jsonl`))).toBe(false);
    expect(traceOf(runId).pop()).toMatchObject({ action: "run_end", status: "error" });
  });

  it("refuses a bad question type and a run id too long for its children, through run() as well", async () => {
    const badType = await run({ runId: "briefing-bad-question", task: "briefing", input: { question: 5 as unknown as string }, sampleMode: true, config });
    expect(badType).toMatchObject({ status: "error", error: { type: "InvalidInput" }, usage: { model_calls: 0 } });
    const long = await run({ runId: "b".repeat(70), task: "briefing", input: {}, sampleMode: true, config });
    expect(long).toMatchObject({ status: "error", error: { type: "InvalidInput" }, log_file: null });
  });

  it("shows a handoff step with its child's task, status and run id for the trace viewer", () => {
    const rows = stepRows(traceOf("briefing-main"));
    const handoffs = rows.filter((row) => row.child !== null).map((row) => row.child);
    expect(handoffs).toEqual([
      { task: "explain_week", status: "success", run_id: "briefing-main-1-explain_week" },
      { task: "thesis_check", status: "success", run_id: "briefing-main-2-thesis_check" },
      { task: "reconcile", status: "needs_human", run_id: "briefing-main-3-reconcile" },
    ]);
    expect(rows.filter((row) => row.child === null && row.action === "handoff")).toHaveLength(0);
  });
});

describe("AGENTS.md rule 3", () => {
  const agents = readFileSync(path.resolve("AGENTS.md"), "utf8");
  const rule = agents.split("\n").find((line) => line.startsWith("3. **Every external call**")) ?? "";

  it("names BRIEFING_TIMEOUT_MS and keeps the 10 min a run", () => {
    expect(rule).toContain("a briefing may run up to BRIEFING_TIMEOUT_MS");
    expect(rule).toContain("10 min a run");
  });

  it("changes no other line: the diff against HEAD is empty or that one line with only those words added", () => {
    let diff: string;
    try {
      diff = execFileSync("git", ["diff", "--no-color", "-U0", "HEAD", "--", "AGENTS.md"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // no git here (a clean clone without .git): the phrase check above still holds
    }
    const changed = diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
    if (changed.length === 0) return; // already committed
    expect(changed).toHaveLength(2);
    const [removed, added] = changed;
    expect(removed.startsWith("-3. ")).toBe(true);
    expect(added).toBe(`+${rule}`);
    expect(added.slice(1).replace("; a briefing may run up to BRIEFING_TIMEOUT_MS", "")).toBe(removed.slice(1));
  });
});
