import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config";
import type { Finding } from "../guards";
import { ModelHttpError, ModelTimeout, type CompleteOptions, type CompleteResult } from "../llm";
import { loadQueryData, type QueryData } from "../queries";
import { RunState } from "../run-state";
import type { TraceInput, Tracer } from "../trace";
import { analyse } from "./analyst";
import { PASS_TOTAL, confidenceOf, coverage, evaluate, scoreSchema, type EvaluateInput } from "./evaluator";
import { plan } from "./planner";

// The seed data in data/, a fake tracer that keeps every line in memory, and the sample model unless a test stubs
// the model. No test here writes a trace file, touches memory or the network.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

const config: Config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const QUESTION = "Why did my portfolio move this week?";

function collector() {
  const lines: TraceInput[] = [];
  const tracer = { log: (line: TraceInput) => (lines.push(line), line as never) } as unknown as Tracer;
  return { lines, tracer };
}

function runState() {
  const { lines, tracer } = collector();
  const run = new RunState({ runId: "t", tracer, config, sampleMode: true, data: d });
  return { lines, tracer, run };
}

/** The sample Planner's plan and the sample Analyst's findings for explain_week, with the run that holds the results. */
async function draft(asOf = AS_OF, question = QUESTION) {
  const { run } = runState();
  const planned = await plan({ task: "explain_week", question, as_of: asOf }, { tracer: run.tracer, sampleMode: true });
  const outcome = await analyse({ task: "explain_week", question, as_of: asOf, focus: planned.focus, steps: planned.steps }, { run });
  if (!outcome.ok) throw new Error(outcome.error.message);
  return { run, findings: outcome.findings, gaps: outcome.gaps };
}

const finding = (subject: string, cites: string[], numbers: Finding["numbers"] = [], claim = `The data shows ${subject}.`): Finding => ({
  kind: "move",
  subject,
  claim,
  numbers,
  cites,
  verdict: null,
  proposed_fix: null,
  memory_ids: [],
});

const input = (run: RunState, findings: Finding[], extra: Partial<EvaluateInput> = {}): EvaluateInput => ({
  task: "explain_week",
  question: QUESTION,
  as_of: AS_OF,
  findings,
  gaps: [],
  results: run.store,
  ...extra,
});

/** A model whose reply is fixed; it records what it was asked. */
function stub(reply: unknown, calls: CompleteOptions[] = []) {
  return async (options: CompleteOptions): Promise<CompleteResult> => {
    calls.push(options);
    return { text: JSON.stringify(reply), json: reply as Record<string, unknown>, usage: { tokens_in: 10, tokens_out: 5 }, duration_ms: 1, model_id: "stub", source: "sample-model" };
  };
}

const evaluatorLines = (lines: TraceInput[], action: string) => lines.filter((line) => line.agent_name === "Evaluator" && line.action === action);
const modelCalls = (lines: TraceInput[]) => lines.filter((line) => line.action === "model_call");

describe("the Evaluator's code checks", () => {
  it("rejects a finding whose number is in no cited row, with a fix written by code, a code_check line and no model call", async () => {
    const { run } = runState();
    const moves = await run.query("week_moves", { as_of: AS_OF });
    const bad = finding("PORTFOLIO", [moves.run_query_id], [{ value: 98765.4, label: "loss" }], "The data shows the portfolio lost Tk 98765.4.");
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, [bad]), { tracer, run });

    expect(outcome).toMatchObject({ accepted: false, scores: null, total: 0, confidence: 0, target_agent: "Planner", model: null });
    expect(outcome.fix).toMatch(/^Fix finding 1 \(move PORTFOLIO\): the number 98765\.4 \(loss\) is not in the cited rows; use only figures from the rows it cites\.$/);
    expect(outcome.code_checks).toEqual([{ check: "citations", ok: false, reason: expect.stringMatching(/98765\.4/), fix: outcome.fix }]);
    const checks = evaluatorLines(lines, "code_check");
    expect(checks).toEqual([expect.objectContaining({ action: "code_check", status: "rejected", why: expect.stringMatching(/98765\.4/) })]);
    expect(checks[0].input_summary).toContain("citations");
    const verdict = evaluatorLines(lines, "reject");
    expect(verdict).toEqual([expect.objectContaining({ target_agent: "Planner", status: "rejected", why: outcome.fix, confidence: 0 })]);
    expect(evaluatorLines(lines, "accept")).toHaveLength(0);
    expect(modelCalls(lines)).toHaveLength(0);
    expect(run.usage.model_calls).toBe(0);
  });

  it("rejects a draft that tells the owner what to trade at the guard check, before coverage and the model", async () => {
    const { run } = runState();
    const moves = await run.query("week_moves", { as_of: AS_OF });
    const bad = finding("BXPHARMA", [moves.run_query_id], [], "You should sell BXPHARMA now.");
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, [bad]), { tracer, run });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code_checks.map((check) => [check.check, check.ok])).toEqual([
      ["citations", true],
      ["guard", false],
    ]);
    expect(outcome.fix).toBe("Remove every sentence that tells the owner to buy, sell or hold; say only what the rows show.");
    expect(evaluatorLines(lines, "code_check").map((line) => line.status)).toEqual(["ok", "rejected"]);
    expect(lines.filter((line) => line.agent_name === "Guard" && line.action === "block")).toHaveLength(1);
    expect(modelCalls(lines)).toHaveLength(0);
  });

  it("rejects the 1 Oct draft without BXPHARMA with the fix 'Explain BXPHARMA: it is the largest move of the week and has no finding.'", async () => {
    const { run, findings, gaps } = await draft();
    const without = findings.filter((f) => f.subject !== "BXPHARMA");
    expect(without.length).toBeLessThan(findings.length);
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, without, { gaps }), { tracer, run });

    expect(outcome.accepted).toBe(false);
    expect(outcome.fix).toBe("Explain BXPHARMA: it is the largest move of the week and has no finding.");
    expect(outcome.code_checks.map((check) => [check.check, check.ok])).toEqual([
      ["citations", true],
      ["guard", true],
      ["coverage", false],
    ]);
    const checks = evaluatorLines(lines, "code_check");
    expect(checks.map((line) => line.status)).toEqual(["ok", "ok", "rejected"]);
    expect(checks[2].why).toMatch(/BXPHARMA is the largest move of the week and has no finding/);
    expect(evaluatorLines(lines, "reject")).toEqual([expect.objectContaining({ target_agent: "Planner", status: "rejected", why: outcome.fix })]);
    expect(modelCalls(lines)).toHaveLength(0);
  });

  it("covers thesis_check by journal id, pre_trade by kind and reconcile by issue_id, each with a fix that names the gap", async () => {
    const { run } = runState();
    const journal = await run.query("journal_for_symbol", { as_of: AS_OF, symbol: "GP" });
    const ids = journal.rows.map((row) => String(row.id));
    expect(ids.length).toBeGreaterThan(0);
    const missing = coverage("thesis_check", [], run.store, AS_OF);
    expect(missing).toMatchObject({ ok: false, fix: `Give each of these theses exactly one finding with a verdict of confirmed, contradicted or open: ${ids.map((id) => `${id}: no thesis finding`).join("; ")}.` });
    const theses = ids.map((id) => ({ ...finding(id, [journal.run_query_id]), kind: "thesis", verdict: "open" }));
    expect(coverage("thesis_check", theses, run.store, AS_OF)).toMatchObject({ ok: true });
    expect(coverage("thesis_check", theses.map((t) => ({ ...t, verdict: null })), run.store, AS_OF)).toMatchObject({ ok: false });

    expect(coverage("pre_trade", [finding("GP", ["q"])], run.store, AS_OF)).toMatchObject({ ok: false, fix: "Report what what_if says the trade would change: the draft has no pre_trade finding." });
    expect(coverage("pre_trade", [{ ...finding("GP", ["q"]), kind: "pre_trade" }], run.store, AS_OF)).toMatchObject({ ok: true });

    expect(coverage("reconcile", [], run.store, AS_OF)).toMatchObject({ ok: false, fix: "Plan reconciliation: no result in this run lists the differences." });
    const reconciliation = await run.query("reconciliation", {});
    const issues = reconciliation.rows.map((row) => String(row.issue_id));
    expect(issues.length).toBeGreaterThan(0);
    expect(coverage("reconcile", [], run.store, AS_OF)).toMatchObject({ ok: false, fix: expect.stringMatching(new RegExp(`^Add a finding and a proposed fix for issue ${issues[0]}: it has no finding`)) });
    const all = issues.map((id) => ({ ...finding(id, [reconciliation.run_query_id]), kind: "reconciliation" }));
    expect(coverage("reconcile", all, run.store, AS_OF)).toMatchObject({ ok: true });
    expect(coverage("reconcile", all.slice(1), run.store, AS_OF)).toMatchObject({ ok: false, fix: expect.stringContaining(issues[0]) });
  });
});

describe("the Evaluator with the sample model", () => {
  it("accepts the full 1 Oct draft with each score 0-3, a total of 7 or more, and confidence = total / 9 rounded to two decimals", async () => {
    const { run, findings, gaps } = await draft();
    const callsBefore = run.usage.model_calls;
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, findings, { gaps }), { tracer, run, round: 1 });

    expect(outcome.accepted).toBe(true);
    expect(outcome.scores).not.toBeNull();
    for (const score of Object.values(outcome.scores!)) {
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(3);
    }
    expect(outcome.total).toBe(outcome.scores!.accuracy + outcome.scores!.appropriateness + outcome.scores!.actionability);
    expect(outcome.total).toBeGreaterThanOrEqual(PASS_TOTAL);
    expect(outcome.fix).toBe("");
    expect(outcome.code_checks.every((check) => check.ok)).toBe(true);
    expect(outcome.code_checks).toHaveLength(3);
    expect(outcome.target_agent).toBe("Writer");
    expect(outcome.model).toMatchObject({ model_id: "sample-model", source: "sample-model" });

    const verdict = evaluatorLines(lines, "accept");
    expect(verdict).toHaveLength(1);
    expect(verdict[0]).toMatchObject({ target_agent: "Writer", status: "accepted", model: "sample-model", retry_count: 1 });
    expect(verdict[0].confidence).toBe(Math.round((outcome.total! / 9) * 100) / 100);
    expect(verdict[0].output_summary).toContain(`accuracy=${outcome.scores!.accuracy} appropriateness=${outcome.scores!.appropriateness} actionability=${outcome.scores!.actionability}`);
    // The tokens are on the model_call line, once; the verdict line repeats nothing, so a run's lines add up.
    expect(verdict[0].usage).toBeUndefined();
    expect(evaluatorLines(lines, "reject")).toHaveLength(0);
    expect(modelCalls(lines)).toHaveLength(1);
    expect(modelCalls(lines)[0].usage).toMatchObject({ model_calls: 1, tokens_in: outcome.model!.usage?.tokens_in, tokens_out: outcome.model!.usage?.tokens_out });
    expect(run.usage.model_calls).toBe(callsBefore + 1);
  });

  it("sends the prompt file as-is and one JSON user message with the task, question, as_of, memories, findings, gaps and only the cited results", async () => {
    const { run, findings, gaps } = await draft();
    const calls: CompleteOptions[] = [];
    const { tracer } = collector();
    const memories = [{ id: "mem-1", tags: ["rule"], content: "Position limit: 25%.", relevance: null, extra: "x" }] as never;
    await evaluate(input(run, findings, { gaps, memories }), { tracer, run, complete: stub({ accuracy: 3, appropriateness: 3, actionability: 3, fix: "" }, calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toBe(readFileSync(path.join(__dirname, "../prompts/evaluator.md"), "utf8"));
    expect(calls[0]).toMatchObject({ model: "fast", json: true, agent: "Evaluator" });
    const user = JSON.parse(calls[0].user) as Record<string, unknown>;
    expect(Object.keys(user)).toEqual(["task", "question", "as_of", "memories", "findings", "gaps", "results"]);
    expect(user).toMatchObject({ task: "explain_week", question: QUESTION, as_of: AS_OF, findings, gaps });
    expect(user.memories).toEqual([{ id: "mem-1", tags: ["rule"], content: "Position limit: 25%.", relevance: null }]);
    const results = user.results as { run_query_id: string; rows: unknown[]; row_count: number }[];
    const cited = [...new Set(findings.flatMap((f) => f.cites))];
    expect(results.map((result) => result.run_query_id)).toEqual(cited);
    expect(results.length).toBeLessThan(Object.keys(run.store).length);
    for (const result of results) expect(result.rows.length).toBe(Math.min(result.row_count, config.MAX_ROWS_PER_QUERY));
  });
});

describe("the Evaluator on a stubbed reply", () => {
  it("validates a good reply and refuses a score outside 0-3", () => {
    expect(scoreSchema.parse({ accuracy: 3, appropriateness: 2, actionability: 2, fix: "" })).toEqual({ accuracy: 3, appropriateness: 2, actionability: 2, fix: "" });
    expect(scoreSchema.parse({ accuracy: 1, appropriateness: 1, actionability: 1 }).fix).toBe("");
    expect(scoreSchema.safeParse({ accuracy: 5, appropriateness: 2, actionability: 2, fix: "" }).success).toBe(false);
    expect(scoreSchema.safeParse({ accuracy: 2.5, appropriateness: 2, actionability: 2, fix: "" }).success).toBe(false);
    expect(confidenceOf(7)).toBe(0.78);
    expect(confidenceOf(9)).toBe(1);
    expect(confidenceOf(6)).toBe(0.67);
  });

  it("rejects a total below 7 with the model's fix, confidence 0.67 and target_agent Planner for explain_week", async () => {
    const { run, findings, gaps } = await draft();
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, findings, { gaps }), { tracer, run, complete: stub({ accuracy: 2, appropriateness: 2, actionability: 2, fix: "Add announcements_between for BXPHARMA." }) });
    expect(outcome).toMatchObject({ accepted: false, scores: { accuracy: 2, appropriateness: 2, actionability: 2 }, total: 6, confidence: 0.67, fix: "Add announcements_between for BXPHARMA.", target_agent: "Planner" });
    expect(evaluatorLines(lines, "reject")).toEqual([expect.objectContaining({ target_agent: "Planner", status: "rejected", why: "Add announcements_between for BXPHARMA.", confidence: 0.67, model: "stub" })]);
  });

  it("sends a pre_trade rejection to the Analyst, and writes a fix when the model gives none", async () => {
    const { run } = runState();
    const preview = await run.query("what_if", { as_of: AS_OF, symbol: "GP", side: "buy", quantity: 10 });
    const draftFinding = { ...finding("GP", [preview.run_query_id]), kind: "pre_trade" as const };
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, [draftFinding], { task: "pre_trade" }), { tracer, run, complete: stub({ accuracy: 3, appropriateness: 1, actionability: 2, fix: "" }) });
    expect(outcome).toMatchObject({ accepted: false, total: 6, target_agent: "Analyst" });
    expect(outcome.fix).toBe("Report every new finding from what_if and whether the trade fits the owner's thesis.");
    expect(evaluatorLines(lines, "reject")).toEqual([expect.objectContaining({ target_agent: "Analyst", why: outcome.fix })]);
  });

  it("ends as a structured error when the reply fails the schema, with no score and no verdict line", async () => {
    const { run, findings, gaps } = await draft();
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, findings, { gaps }), { tracer, run, complete: stub({ accuracy: "high", fix: "" }) });
    expect(outcome).toMatchObject({ accepted: false, scores: null, total: 0, confidence: 0, error: { type: "BadJson", recoverable: true } });
    expect(outcome.error?.message).toMatch(/Evaluator schema/);
    expect(evaluatorLines(lines, "bad_reply")).toEqual([expect.objectContaining({ status: "error" })]);
    expect(evaluatorLines(lines, "accept")).toHaveLength(0);
    expect(evaluatorLines(lines, "reject")).toHaveLength(0);
  });

  it("accepts a plain tracer as the second argument and counts no run budget then", async () => {
    const { run, findings, gaps } = await draft();
    const calls = run.usage.model_calls;
    const { lines, tracer } = collector();
    const outcome = await evaluate(input(run, findings, { gaps }), tracer);
    expect(outcome.accepted).toBe(true);
    expect(modelCalls(lines)).toHaveLength(1);
    expect(run.usage.model_calls).toBe(calls);
  });
});

describe("the Evaluator when the fast model returns no answer", () => {
  // What llm.ts throws after a 502 empty_response and its one retry at max_tokens 8000.
  const noAnswer = (calls: CompleteOptions[] = []) => async (options: CompleteOptions): Promise<CompleteResult> => {
    calls.push(options);
    throw new ModelHttpError("The fast model call failed twice: 502 empty_response", 502);
  };

  it("accepts a draft that passed the code checks with score, total and confidence null and one score_unavailable line", async () => {
    const { run, findings, gaps } = await draft();
    const { lines, tracer } = collector();
    const calls: CompleteOptions[] = [];
    const outcome = await evaluate(input(run, findings, { gaps }), { tracer, run, round: 1, complete: noAnswer(calls) });
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ accepted: true, scores: null, total: null, confidence: null, fix: "", target_agent: "Writer", model: null });
    expect(outcome.error).toBeUndefined();
    expect(outcome.code_checks.map((check) => [check.check, check.ok])).toEqual([["citations", true], ["guard", true], ["coverage", true]]);
    const unavailable = evaluatorLines(lines, "score_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ target_agent: "Writer", status: "accepted", why: "the model returned no answer; the code checks passed", confidence: null, retry_count: 1 });
    expect(evaluatorLines(lines, "accept")).toHaveLength(0);
    expect(evaluatorLines(lines, "reject")).toHaveLength(0);
  });

  it("still rejects a draft that fails a code check, with no model call and no score_unavailable line", async () => {
    const { run } = runState();
    const moves = await run.query("week_moves", { as_of: AS_OF });
    const { lines, tracer } = collector();
    const calls: CompleteOptions[] = [];
    const bad = finding("BXPHARMA", [moves.run_query_id], [{ label: "made up", value: 123456.78 }]);
    const outcome = await evaluate(input(run, [bad]), { tracer, run, complete: noAnswer(calls) });
    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({ accepted: false, scores: null, total: 0, confidence: 0, target_agent: "Planner" });
    expect(outcome.fix).not.toBe("");
    expect(evaluatorLines(lines, "reject")).toHaveLength(1);
    expect(evaluatorLines(lines, "score_unavailable")).toHaveLength(0);
  });

  it("passes any other model error through unchanged", async () => {
    const { run, findings, gaps } = await draft();
    const { lines, tracer } = collector();
    const timeout = async (): Promise<CompleteResult> => {
      throw new ModelTimeout("The fast model call timed out twice.");
    };
    await expect(evaluate(input(run, findings, { gaps }), { tracer, run, complete: timeout })).rejects.toBeInstanceOf(ModelTimeout);
    expect(evaluatorLines(lines, "score_unavailable")).toHaveLength(0);
  });
});
