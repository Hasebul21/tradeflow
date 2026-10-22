import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryBlockedError, memoryDir, openMemory, recall, remember, seedOwnerContext, withMiner, type MinerUsage } from "./memory";
import { startRun, type TraceLine, type Tracer } from "./trace";

// Each test gets its own copy of data/ through TRADEFLOW_DATA_DIR, so it has its own memory/ folder and never
// touches data/ itself.
let dir: string;
const traces: Tracer[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-memory-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  process.env.SAMPLE_MODE = "true";
});

afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  delete process.env.SAMPLE_MODE;
  await rm(dir, { recursive: true, force: true });
  for (const tracer of traces.splice(0)) await rm(tracer.file, { force: true });
});

function run(id: string): Tracer {
  const tracer = startRun(id);
  traces.push(tracer);
  return tracer;
}

const traceLines = (tracer: Tracer): TraceLine[] =>
  readFileSync(tracer.file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceLine);

const recallLine = (tracer: Tracer): TraceLine => traceLines(tracer).filter((l) => l.agent_name === "Memory" && l.action === "recall").at(-1)!;

/** "by_tag=a,b; by_query=none; corrections=none" as an object. */
const summary = (line: TraceLine): Record<string, string> =>
  Object.fromEntries(line.output_summary.split("; ").map((part) => part.split("=") as [string, string]));

const REVIEW = "Week to 24 Sep: GP fell on its ex-dividend date.";

describe("recall", () => {
  it("takes the review of 24 Sep by tag for 1 Oct, and not for 24 Sep itself", async () => {
    const tracer = run("review-0924");
    const id = await remember({ content: REVIEW, task: "explain_week", asOf: "2026-09-24", runId: "review-0924", tracer });

    const found = await recall("Why did my portfolio move this week?", "2026-10-01", tracer);
    expect(found.map((m) => m.id)).toContain(id);
    expect(found.find((m) => m.id === id)).toMatchObject({ content: REVIEW, relevance: null });
    const line = recallLine(tracer);
    expect(summary(line).by_tag).toBe(id);
    expect(summary(line).by_query.split(",")).not.toContain(id);
    expect(line.retrievalReason).toContain("hybrid ranking");
    expect(["minimal", "personal", "comprehensive"]).toContain(line.strategy);

    const sameDay = await recall("Why did my portfolio move this week?", "2026-09-24", tracer);
    expect(sameDay.map((m) => m.id)).not.toContain(id);
  });

  it("takes the latest review before asOf, and the later-written one on a tie", async () => {
    const tracer = run("review-latest");
    const base = { task: "explain_week", runId: "review-latest", tracer };
    await remember({ ...base, content: "Week to 17 Sep: quiet week.", asOf: "2026-09-17" });
    const first = await remember({ ...base, content: "Week to 24 Sep: first note.", asOf: "2026-09-24" });
    const second = await remember({ ...base, content: "Week to 24 Sep: second note.", asOf: "2026-09-24" });

    const found = await recall("Anything unrelated to the notes zzz?", "2026-10-01", tracer);
    expect(found.map((m) => m.id)).toContain(second);
    expect(found.map((m) => m.id)).not.toContain(first);
    expect(recallLine(tracer).output_summary).toContain(`by_tag=${second};`);
  });

  it("returns a memory whose content equals the question from the query, with a relevance", async () => {
    const tracer = run("review-query");
    const question = "Which sector is the owner most worried about this month?";
    const id = openMemory().add({ content: question, type: "general", source: "test", tags: ["note"] }).id;

    const found = await recall(question, "2026-10-01", tracer);
    const hit = found.find((m) => m.id === id);
    expect(hit).toBeDefined();
    expect(hit!.relevance).not.toBeNull();
    expect(recallLine(tracer).output_summary).toContain(`by_query=${id}`);
  });

  it("returns at most 5 memories, each with only id, tags, content and relevance", async () => {
    const tracer = run("review-cap");
    await seedOwnerContext(tracer);
    const question = "Which sector is the owner most worried about this month?";
    const hmem = openMemory();
    const corrections = [1, 2].map((i) => hmem.add({ content: `Owner correction number ${i}.`, type: "preference", source: "test", tags: ["correction", "2026-09-30"] }).id);
    for (let i = 0; i < 8; i += 1) hmem.add({ content: question, type: "general", source: "test", tags: ["note"] });

    const filled = await recall(question, "2026-10-01", tracer);
    expect(filled).toHaveLength(5);
    expect(filled.slice(0, 2).map((m) => m.id)).toEqual([corrections[1], corrections[0]]);
    expect(filled.slice(0, 2).every((m) => m.relevance === null)).toBe(true);
    expect(filled.slice(2).every((m) => m.relevance !== null)).toBe(true);

    for (let i = 3; i <= 9; i += 1) hmem.add({ content: `Owner correction number ${i}.`, type: "preference", source: "test", tags: ["correction", "2026-09-30"] });
    const crowded = await recall(question, "2026-10-01", tracer);
    expect(crowded).toHaveLength(5);
    expect(crowded.every((m) => m.relevance === null)).toBe(true);
    for (const memory of [...filled, ...crowded]) {
      expect(Object.keys(memory).sort()).toEqual(["content", "id", "relevance", "tags"]);
    }
  });

  it("skips a correction dated after asOf and puts the correction ids on the trace line", async () => {
    const tracer = run("review-corrections");
    const early = openMemory().add({ content: "Owner correction early.", type: "preference", source: "test", tags: ["correction", "2026-09-20"] }).id;
    const late = openMemory().add({ content: "Owner correction late.", type: "preference", source: "test", tags: ["correction", "2026-10-05"] }).id;

    const found = await recall("Anything unrelated zzz?", "2026-10-01", tracer);
    expect(found.map((m) => m.id)).toContain(early);
    expect(found.map((m) => m.id)).not.toContain(late);
    expect(recallLine(tracer).output_summary).toContain(`corrections=${early}`);
  });

  it("finds the position-limit rule for a question about limits", async () => {
    const tracer = run("review-limit");
    await seedOwnerContext();
    // The reference embedder is a hash: a question needs to share most of its words with the memory to pass 0.35.
    const found = await recall("Position limit: no single stock above what % of the portfolio's market value?", "2026-10-01", tracer);
    expect(found.some((m) => m.content.startsWith("Position limit: no single stock above 25%"))).toBe(true);
  });
});

describe("seedOwnerContext", () => {
  it("adds nothing the second time", async () => {
    const tracer = run("review-seed");
    const first = await seedOwnerContext(tracer);
    const count = openMemory().store.all().length;
    expect(first.added).toBe(count);
    expect(first.added).toBeGreaterThan(20);

    const second = await seedOwnerContext(tracer);
    expect(second.added).toBe(0);
    expect(second.already_present).toBe(first.added);
    expect(openMemory().store.all()).toHaveLength(count);
    const seeds = traceLines(tracer).filter((l) => l.action === "seed");
    expect(seeds.map((l) => l.output_summary)).toEqual([`added=${first.added}; already_present=0`, `added=0; already_present=${first.added}`]);
  });

  it("stores the rules, the plans and the profile as long-term preferences", async () => {
    await seedOwnerContext();
    const all = openMemory().store.all();
    const sources = new Set(all.map((m) => m.source));
    for (const source of ["seed:rules:position_limit", "seed:rules:sector:Bank", "seed:rules:plan:p-10", "seed:profile:review_day", "seed:profile:goal"]) {
      expect(sources.has(source)).toBe(true);
    }
    const preferences = all.filter((m) => !m.tags.includes("thesis"));
    expect(preferences.every((m) => m.type === "preference" && m.layer === "long_term")).toBe(true);
    expect(all.find((m) => m.source === "seed:rules:plan:p-05")!.content).toContain("BATBC");
    expect(all.find((m) => m.source === "seed:profile:review_day")!.content).toContain("Thursday");
  });

  it("writes the thesis of j-001 with GP and its exit condition, and of j-005 with BATBC and none", async () => {
    await seedOwnerContext();
    const all = openMemory().store.all();
    const j1 = all.find((m) => m.source === "seed:journal:j-001")!;
    expect(j1.type).toBe("personal");
    expect(j1.tags).toContain("thesis");
    expect(j1.content).toContain("GP");
    expect(j1.content).toContain("Sell if the dividend is cut.");

    const j5 = all.find((m) => m.source === "seed:journal:j-005")!;
    expect(j5.tags).toContain("thesis");
    expect(j5.content).toContain("BATBC");
    expect(j5.content).toContain("j-005");
    expect(j5.content).toContain("No exit condition recorded.");
    expect(j5.content).not.toContain("Exit condition:");
    for (const memory of [j1, j5]) {
      expect(memory.content).not.toMatch(/null|undefined/);
    }
  });
});

describe("remember", () => {
  it("writes state.json and ledger.jsonl, and traces a ledger line with the last entry's memoryId", async () => {
    const tracer = run("review-ledger");
    const id = await remember({ content: REVIEW, task: "explain_week", asOf: "2026-09-24", runId: "review-ledger", tracer });

    expect(memoryDir()).toBe(path.join(dir, "memory"));
    expect(existsSync(path.join(dir, "memory", "state.json"))).toBe(true);
    const ledger = (await readFile(path.join(dir, "memory", "ledger.jsonl"), "utf8")).split("\n").filter(Boolean);
    const last = JSON.parse(ledger.at(-1)!) as { memoryId: string; action: string; actor: string };
    expect(last.memoryId).toBe(id);

    const lines = traceLines(tracer).filter((l) => l.agent_name === "Memory");
    expect(lines.map((l) => l.action)).toEqual(["remember", "ledger"]);
    expect(lines[1].output_summary).toBe(`memoryId=${last.memoryId}; action=${last.action}; actor=${last.actor}`);
    expect(last.action).toBe("create");
  });

  it("tags the memory review, the task, the as_of date and the run", async () => {
    const tracer = run("review-tags");
    const id = await remember({ content: REVIEW, task: "explain_week", asOf: "2026-09-24", runId: "review-tags", tracer });
    const record = openMemory().store.get(id)!;
    expect(record.tags).toEqual(["review", "explain_week", "2026-09-24", "run:review-tags"]);
    expect(record).toMatchObject({ type: "general", source: "agent:writer" });
  });

  it("stores nothing and writes one Guard block line when guards.beforeRemember refuses the text", async () => {
    const tracer = run("review-blocked");
    const before = openMemory().store.all().length;
    const text = "x".repeat(700);
    const error = await remember({ content: text, task: "explain_week", asOf: "2026-09-24", runId: "review-blocked", tracer }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryBlockedError);
    expect((error as MemoryBlockedError).reason).toMatch(/700 characters; the limit is 600/);
    expect(openMemory().store.all()).toHaveLength(before);
    expect(existsSync(path.join(dir, "memory", "ledger.jsonl"))).toBe(false);
    const lines = traceLines(tracer);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agent_name: "Guard", action: "block", status: "blocked" });
  });

  it("rejects an asOf that is not a date", async () => {
    await expect(remember({ content: REVIEW, task: "explain_week", asOf: "last week", runId: "x", tracer: run("review-bad") })).rejects.toThrow(/yyyy-mm-dd/);
  });
});

describe("the miner", () => {
  it("traces its model call through the caller's tracer and adds its usage", async () => {
    const tracer = run("review-miner");
    const usage: MinerUsage = { model_calls: 0, tokens_in: 0, tokens_out: 0 };
    const made = await withMiner({ tracer, usage }, () => openMemory().mine("user_correction", "Always trim the overweight pharma position before adding."));
    expect(made.length).toBeGreaterThan(0);
    expect(made[0].content).toContain("overweight pharma");
    expect(usage.model_calls).toBe(1);
    expect(usage.tokens_in).toBeGreaterThan(0);
    const call = traceLines(tracer).find((l) => l.agent_name === "Memory" && l.action === "model_call")!;
    expect(call.status).toBe("ok");
  });

  it("refuses to run outside a run, and past MAX_MODEL_CALLS", async () => {
    await expect(openMemory().mine("user_correction", "Always trim the overweight pharma position.")).rejects.toThrow(/withMiner/);
    const usage: MinerUsage = { model_calls: 12, tokens_in: 0, tokens_out: 0 };
    await expect(
      withMiner({ tracer: run("review-miner-cap"), usage }, () => openMemory().mine("user_correction", "Always trim the overweight pharma position.")),
    ).rejects.toThrow(/MAX_MODEL_CALLS/);
    expect(usage.model_calls).toBe(12);
  });
});
