import { cp, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import type { CompleteOptions, CompleteResult } from "./llm";
import { run, type RunResult } from "./orchestrator";

// thesis_check as of 2026-10-01 with the sample model, on a temporary copy of data/ through TRADEFLOW_DATA_DIR. The
// sample model is wrapped so every model call is recorded; the real sample model still answers.
const calls = vi.hoisted(() => ({ list: [] as CompleteOptions[] }));
vi.mock("./sample-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sample-model")>();
  const complete = async (options: CompleteOptions): Promise<CompleteResult> => {
    calls.list.push(options);
    return actual.complete(options);
  };
  return { ...actual, complete };
});

const config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const VERDICTS = ["confirmed", "contradicted", "open"];

let dir: string;
let withQuestion: RunResult;
let withoutQuestion: RunResult;
let journalIds: string[];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-thesis-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  const journal = JSON.parse(readFileSync(path.join(dir, "journal.json"), "utf8")) as { id: string }[];
  journalIds = journal.map((entry) => entry.id);
  calls.list.length = 0;
  withQuestion = await run({ runId: "thesis-with-question", task: "thesis_check", input: { question: "Do my theses still hold?", as_of: AS_OF }, sampleMode: true, config });
  const firstCalls = [...calls.list];
  calls.list.length = 0;
  withoutQuestion = await run({ runId: "thesis-no-question", task: "thesis_check", input: { as_of: AS_OF }, sampleMode: true, config });
  calls.list.unshift(...firstCalls);
}, 60_000);

afterAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("thesis_check, sample model", () => {
  it("returns exactly one verdict per journal thesis, each citing a run_query_id from this run", () => {
    expect(withQuestion.status).toBe("success");
    const verdicts = withQuestion.output?.verdicts ?? [];
    expect(verdicts.map((v) => v.journal_id).sort()).toEqual([...journalIds].sort());
    const ran = new Set(withQuestion.output?.citations.map((c) => c.run_query_id));
    for (const v of verdicts) {
      expect(VERDICTS).toContain(v.verdict);
      expect(v.cites.length).toBeGreaterThan(0);
      for (const cite of v.cites) expect(ran.has(cite)).toBe(true);
    }
  });

  it("runs with no question and returns success", () => {
    expect(withoutQuestion.status).toBe("success");
    expect(withoutQuestion.error).toBeNull();
    expect(withoutQuestion.output?.verdicts?.length).toBe(journalIds.length);
  });

  it("keeps every model call's system plus user within MAX_PROMPT_CHARS", () => {
    expect(calls.list.length).toBeGreaterThan(0);
    for (const call of calls.list) expect(call.system.length + call.user.length).toBeLessThanOrEqual(config.MAX_PROMPT_CHARS);
  });

  it("settles each thesis by its rules: j-001 open, j-005 confirmed, j-013 contradicted, j-014 open", () => {
    const verdicts = Object.fromEntries((withQuestion.output?.verdicts ?? []).map((v) => [v.journal_id, v.verdict]));
    expect(verdicts["j-001"]).toBe("open");
    expect(verdicts["j-005"]).toBe("confirmed");
    expect(verdicts["j-013"]).toBe("contradicted");
    expect(verdicts["j-014"]).toBe("open");
  });

  it("says in the j-001 claim that the dividend is owed, not paid", () => {
    const claim = withQuestion.output?.findings.find((f) => f.subject === "j-001")?.claim ?? "";
    expect(claim).toMatch(/owed, not paid/);
  });
});

describe("thesis evidence gaps", () => {
  it("puts only the query id in code_gaps for a query that did not run, and the params and reason in gaps", async () => {
    const { loadQueryData } = await import("./queries");
    const { RunState } = await import("./run-state");
    const { prepareThesisEvidence } = await import("./thesis");
    const { numbersIn } = await import("./guards");
    const tracer = { log: (line: unknown) => line } as never;
    // Three query calls: the journal and two fundamentals run; the rest are refused by the budget and become gaps.
    const tight = loadConfig({ SAMPLE_MODE: "true", MAX_QUERY_CALLS: "3" }, () => {});
    const state = new RunState({ runId: "thesis-gaps", tracer, config: tight, sampleMode: true, data: await loadQueryData() });
    const prepared = await prepareThesisEvidence({ state, tracer, asOf: AS_OF, steps: [], round: 0 });
    expect(prepared.gaps.length).toBeGreaterThan(0);
    expect(prepared.gaps.some((gap) => /^fundamentals_latest \{.*\} did not run: /.test(gap))).toBe(true);
    expect(prepared.code_gaps).toContain("fundamentals_latest did not run.");
    expect(prepared.code_gaps.every((gap) => /^[a-z_]+ did not run\.$/.test(gap))).toBe(true);
    expect(prepared.code_gaps.flatMap((gap) => numbersIn(gap))).toEqual([]);
    expect(prepared.theses.every((thesis) => thesis.journal_run_query_id !== null)).toBe(true);
  });
});
