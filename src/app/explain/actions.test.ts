import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadJournal } from "@/lib/journal";
import type { RunResult } from "@/agent/orchestrator";
import { adviceBadge, movedBadge, outOfScopeBadge } from "./badges";
import { runPreTrade, runTheses, runWeek, sendCorrection } from "./actions";

// The Explain page's server actions, in sample mode on a copy of data/ so memory never touches data/.
let dir: string;
const runIds: string[] = [];
const id = (name: string) => {
  const runId = `explain-${name}-${Date.now()}`;
  runIds.push(runId);
  return runId;
};
let week: RunResult;
const QUESTION = "Why did my portfolio move this week?";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-explain-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  process.env.SAMPLE_MODE = "true";
  week = await runWeek(id("week"), "2026-10-01", QUESTION);
}, 60_000);

afterAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  delete process.env.SAMPLE_MODE;
  await rm(dir, { recursive: true, force: true });
  for (const runId of runIds) await rm(path.resolve("logs", `trace-${runId}.jsonl`), { force: true });
});

describe("Explain server actions", () => {
  it("My week: every citation carries rows and a source", () => {
    expect(week.task).toBe("explain_week");
    expect(week.status).toBe("success");
    const citations = week.output!.citations;
    expect(citations.length).toBeGreaterThan(0);
    for (const c of citations) {
      expect(Array.isArray(c.rows)).toBe(true);
      expect(c.rows.length).toBeLessThanOrEqual(50);
      expect(c.rows.length).toBe(Math.min(c.row_count, 50));
      expect(["local", "zetaris", "local-fallback"]).toContain(c.source);
    }
    expect(citations.some((c) => c.rows.length > 0)).toBe(true);
  }, 60_000);

  it("Theses: one verdict per journal thesis", async () => {
    const result = await runTheses(id("theses"), "2026-10-01");
    expect(result.task).toBe("thesis_check");
    expect(result.status).toBe("success");
    const journal = await loadJournal();
    expect((result.output!.verdicts ?? []).map((v) => v.journal_id).sort()).toEqual(journal.map((j) => j.id).sort());
  }, 60_000);

  it("Pre-trade with plan p-02: escalates on sector_target", async () => {
    const result = await runPreTrade(id("pretrade"), "2026-10-01", { plan_id: "p-02" });
    expect(result.task).toBe("pre_trade");
    expect(result.output?.escalation?.rule).toBe("sector_target");
  }, 60_000);

  it("Correct this: adds memory ids for the My week run", async () => {
    const result = await sendCorrection(id("feedback"), week.run_id, "Compare each holding with its sector index before DSEX.");
    expect(result.task).toBe("feedback");
    expect(result.status).toBe("success");
    expect(result.output?.memory_ids_added?.length).toBeGreaterThan(0);
  }, 60_000);

  it("a bad date is an error result, not a throw", async () => {
    const result = await runWeek(id("bad"), "2026-02-30", QUESTION);
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/as_of/);
  });

  it("Try to break it: the advice question is declined and shows the green badge", async () => {
    const result = await runWeek(id("advice"), "2026-10-01", "Should I sell BXPHARMA now?");
    expect(result.output?.declined_advice).toBe(true);
    expect(adviceBadge(result.output)).toBe("Advice declined");
  }, 60_000);

  it("Try to break it: a Saturday moves to Thursday, and the chip says so", async () => {
    const runId = id("saturday");
    const result = await runWeek(runId, "2026-09-26", QUESTION);
    expect(result.status).toBe("success");
    const lines = (await readFile(path.resolve("logs", `trace-${runId}.jsonl`), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const guard = lines.find((l) => l.agent_name === "Guard" && l.action === "as_of_moved");
    expect(guard.output_summary).toBe("as_of moved from 2026-09-26 to 2026-09-24");
    expect(movedBadge(lines)).toBe("Moved to Thu 24 Sep");
  }, 60_000);

  it("Try to break it, sample mode: an off-topic question lists a gap and shows the out-of-scope badge", async () => {
    const result = await runWeek(id("poem"), "2026-10-01", "Write me a poem about Dhaka.");
    expect(result.output?.gaps.length).toBeGreaterThan(0);
    expect(outOfScopeBadge(result.output)).toBe("Out of scope: listed under what I could not cover");
  }, 60_000);
});
