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

const RULE4_WORDS = ", and at most `MAX_CONCURRENT_CHILDREN` briefing children at a time (set it to 1 if the model provider rate-limits parallel calls)";
const RULE6_WORDS = '`beforeQuery` and `beforeRemember` also check `src/agent/policy.ts`, who may run which query for which task and who may write which memory kind; a refusal is a Guard line "policy_denied".';

describe("AGENTS.md rule 3", () => {
  const agents = readFileSync(path.resolve("AGENTS.md"), "utf8");
  const rule = agents.split("\n").find((line) => line.startsWith("3. **Every external call**")) ?? "";

  it("names BRIEFING_TIMEOUT_MS and keeps the 40 min a run", () => {
    expect(rule).toContain("a briefing may run up to BRIEFING_TIMEOUT_MS");
    expect(rule).toContain("40 min a run");
  });

  it("changes no other line: the diff against HEAD is empty or that one line with only those words added", () => {
    let diff: string;
    try {
      diff = execFileSync("git", ["diff", "--no-color", "-U0", "HEAD", "--", "AGENTS.md"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // no git here (a clean clone without .git): the phrase check above still holds
    }
    // This guards the briefing step's own uncommitted edit. Once HEAD has this rule 3 line, it has done its job,
    // and later steps may change other lines of AGENTS.md (Step 20g rewrites the kit lines at the top).
    let committed = "";
    try {
      committed = execFileSync("git", ["show", "HEAD:AGENTS.md"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      committed = "";
    }
    if (committed.split("\n").includes(rule)) return;
    // Later edits to the numbers in this line (Step 20i raised the timeouts) keep the BRIEFING_TIMEOUT_MS words: HEAD already has them.
    if (committed.split("\n").some((line) => line.startsWith("3. **Every external call**") && line.includes("a briefing may run up to BRIEFING_TIMEOUT_MS"))) return;
    // Step 20b also adds the MAX_CONCURRENT_CHILDREN words to rule 4: that one pair of lines is allowed, with nothing else changed in it.
    // Step 20c adds the MAX_CONCURRENT_RUNS and cancelled words to the same rule, so its old line may differ from the one without the words.
    const rule4 = agents.split("\n").find((line) => line.startsWith("4. **Bounded loop.**")) ?? "";
    expect(rule4).toContain(RULE4_WORDS);
    // Step 20e adds one sentence to rule 6 (the tool policy): that pair of lines is allowed too, and nothing else of it.
    const rule6 = agents.split("\n").find((line) => line.startsWith("6. **Guards.**")) ?? "";
    expect(rule6).toContain(RULE6_WORDS);
    const changed = diff
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
      .filter((line) => line !== `+${rule4}` && line !== `-${rule4.replace(RULE4_WORDS, "")}` && !line.startsWith("-4. **Bounded loop.**"))
      .filter((line) => line !== `+${rule6}` && line !== `-${rule6.replace(` ${RULE6_WORDS}`, "")}`);
    if (changed.length === 0) return; // already committed
    expect(changed).toHaveLength(2);
    const [removed, added] = changed;
    expect(removed.startsWith("-3. ")).toBe(true);
    expect(added).toBe(`+${rule}`);
    expect(added.slice(1).replace("; a briefing may run up to BRIEFING_TIMEOUT_MS", "")).toBe(removed.slice(1));
  });
});

// Concurrency: the children run through runWithLimit under MAX_CONCURRENT_CHILDREN. The stub replaces runChild, so
// nothing here depends on the model; the sections and handoff lines must still come out in task order.
const DELAY_MS = 300;
const stubSuccess =
  (delayMs: number): RunChild =>
  async (options) => {
    const task = options.task ?? "briefing";
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const usage = { model_calls: 1, query_calls: 1, tokens_in: 10, tokens_out: 5, duration_ms: delayMs };
    return {
      run_id: options.runId,
      task,
      status: "success",
      output: { summary: `${task} done`, review_markdown: `${task} review\n\n${DISCLAIMER}`, findings: [], gaps: [], citations: [], needs_human: false, declined_advice: false, injection_seen: false, memories_recalled: [], applied_corrections: [], rounds: 1, scores: null, model_source: "sample-model", partial: false, stop_reason: null },
      error: null,
      agents: [],
      usage,
      trace_id: options.runId,
      log_file: null,
      execution_time_seconds: delayMs / 1000,
    };
  };
const capConfig = (cap: number) => loadConfig({ SAMPLE_MODE: "true", MAX_CONCURRENT_CHILDREN: String(cap) }, () => {});
const handoffsOf = (runId: string) => traceOf(runId).filter((line) => line.agent_name === "Orchestrator" && line.action === "handoff");

describe("briefing concurrency", () => {
  it("runs the three children at once at cap 3: under 700 ms, sections in task order", async () => {
    const started = Date.now();
    const result = await briefing({ runId: "briefing-cap3", input: { as_of: AS_OF }, sampleMode: true, config: capConfig(3) }, stubSuccess(DELAY_MS));
    const took = Date.now() - started;
    expect(took).toBeLessThan(700);
    expect(result.status).toBe("success");
    expect(result.output!.sections!.map((section) => section.task)).toEqual(ORDER);
    expect(handoffsOf("briefing-cap3").map((line) => line.target_agent)).toEqual(ORDER);
    expect(result.usage.duration_ms).toBeGreaterThanOrEqual(DELAY_MS);
    console.info(`briefing cap 3: ${took} ms`);
  });

  it("runs them one after another at cap 1: 850 ms or more, sections in task order, usage summed", async () => {
    const started = Date.now();
    const result = await briefing({ runId: "briefing-cap1", input: { as_of: AS_OF }, sampleMode: true, config: capConfig(1) }, stubSuccess(DELAY_MS));
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(850);
    expect(result.output!.sections!.map((section) => section.task)).toEqual(ORDER);
    expect(result.usage.model_calls).toBe(3);
    const [first, second, third] = handoffsOf("briefing-cap1");
    expect(Date.parse(second.started_at!)).toBeGreaterThanOrEqual(Date.parse(first.finished_at!));
    expect(Date.parse(third.started_at!)).toBeGreaterThanOrEqual(Date.parse(second.finished_at!));
    console.info(`briefing cap 1: ${took} ms`);
  });

  it("at cap 2 starts two children together and the third after one of them finished", async () => {
    const started = Date.now();
    const result = await briefing({ runId: "briefing-cap2-stub", input: { as_of: AS_OF }, sampleMode: true, config: capConfig(2) }, stubSuccess(DELAY_MS));
    console.info(`briefing cap 2: ${Date.now() - started} ms`);
    expect(result.output!.sections!.map((section) => section.task)).toEqual(ORDER);
    const [first, second, third] = handoffsOf("briefing-cap2-stub");
    expect(Math.abs(Date.parse(first.started_at!) - Date.parse(second.started_at!))).toBeLessThan(150);
    const earlierFinish = Math.min(Date.parse(first.finished_at!), Date.parse(second.finished_at!));
    expect(Date.parse(third.started_at!)).toBeGreaterThanOrEqual(earlierFinish);
  });

  it("a plain briefing writes one fixed_plan naming the cap, three handoff lines in task order with times, then run_end with usage", () => {
    const lines = traceOf("briefing-main");
    const orchestrator = lines.filter((line) => line.agent_name === "Orchestrator");
    expect(orchestrator.map((line) => line.action)).toEqual(["fixed_plan", "handoff", "handoff", "handoff", "run_end"]);
    expect(orchestrator[0].output_summary).toContain("3 children, up to 2 at a time");
    const handoffs = orchestrator.filter((line) => line.action === "handoff");
    expect(handoffs.map((line) => line.target_agent)).toEqual(ORDER);
    for (const handoff of handoffs) {
      expect(handoff.child_run_id).toMatch(/^briefing-main-[123]-/);
      expect(Date.parse(handoff.started_at!)).toBeLessThanOrEqual(Date.parse(handoff.finished_at!));
    }
    // Only handoff lines carry started_at and finished_at.
    expect(lines.filter((line) => line.started_at !== undefined || line.finished_at !== undefined)).toHaveLength(3);
    expect(lines[lines.length - 1]).toMatchObject({ agent_name: "Orchestrator", action: "run_end", usage: expect.objectContaining({ model_calls: main.usage.model_calls }) });
    // The trace viewer shows the times on a handoff step and on no other step.
    const times = stepRows(lines).filter((row) => row.times !== null);
    expect(times.map((row) => row.action)).toEqual(["handoff", "handoff", "handoff"]);
  });

  it("at cap 2 leaves the memory store holding each child's review, and its files parse as JSON", async () => {
    const result = await briefing({ runId: "briefing-cap2", input: { as_of: AS_OF }, sampleMode: true, config: capConfig(2) });
    expect(result.status).toBe("success");
    const state = JSON.parse(readFileSync(path.join(dir, "memory", "state.json"), "utf8")) as { seq: number; records: { id: string; tags: string[] }[] };
    const wrote = result.output!.sections!.filter((section) => traceOf(section.run_id).some((line) => line.agent_name === "Memory" && line.action === "remember"));
    expect(wrote.map((section) => section.task)).toEqual(expect.arrayContaining(["explain_week", "thesis_check"]));
    for (const section of wrote) {
      expect(state.records.filter((record) => record.tags.includes("review") && record.tags.includes(`run:${section.run_id}`))).toHaveLength(1);
    }
    expect(new Set(state.records.map((record) => record.id)).size).toBe(state.records.length);
    for (const line of readFileSync(path.join(dir, "memory", "ledger.jsonl"), "utf8").split("\n").filter(Boolean)) JSON.parse(line);
    const world = readFileSync(path.join(dir, "memory", "world", ".world", "tradeflow.json"), "utf8");
    expect(() => JSON.parse(world)).not.toThrow();
  }, 120_000);
});
