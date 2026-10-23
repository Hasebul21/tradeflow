import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config";
import { checkCitations, type Finding } from "../guards";
import type { CompleteOptions, CompleteResult, HistoryMessage } from "../llm";
import type { RecalledMemory } from "../memory";
import { loadQueryData, type QueryData } from "../queries";
import { BudgetExhaustedError, RunState } from "../run-state";
import type { TraceInput, Tracer } from "../trace";
import { analyse, analystReplySchema, codeGaps, toolsFor, type AnalysisRequest } from "./analyst";
import { plan, type PlannedStep } from "./planner";

// The seed data in data/, a fake tracer that keeps every line in memory, and the sample model unless a test stubs
// the model. No test here writes a trace file or touches the network.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

const config: Config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const WEEK_START = "2026-09-24";

function collector() {
  const lines: TraceInput[] = [];
  const tracer = { log: (line: TraceInput) => (lines.push(line), line as never) } as unknown as Tracer;
  return { lines, tracer };
}

function runState(extra: Partial<ConstructorParameters<typeof RunState>[0]> = {}) {
  const { lines, tracer } = collector();
  const run = new RunState({ runId: "t", tracer, config, sampleMode: true, data: d, ...extra });
  return { lines, tracer, run };
}

const step = (query_id: PlannedStep["query_id"], params: Record<string, unknown> = { as_of: AS_OF }): PlannedStep => ({ query_id, params, why: `Why ${query_id}.` });
const weekPlan = (): PlannedStep[] => [
  step("week_moves"),
  step("sector_vs_stock"),
  step("announcements_between", { from: WEEK_START, to: AS_OF }),
  step("dividends_between", { from: WEEK_START, to: AS_OF }),
  step("rule_findings"),
];
const request = (steps: PlannedStep[], extra: Partial<AnalysisRequest> = {}): AnalysisRequest => ({
  task: "explain_week",
  question: "Why did my portfolio move this week?",
  as_of: AS_OF,
  focus: "Why the portfolio moved in the week to 2026-10-01.",
  steps,
  ...extra,
});

const finding = (subject: string, cites: string[], numbers: Finding["numbers"] = []): Finding => ({
  kind: "move",
  subject,
  claim: `The data shows ${subject}.`,
  numbers,
  cites,
  verdict: null,
  proposed_fix: null,
  memory_ids: [],
});
const done = (findings: Finding[]) => ({ findings, gaps: [] });

/** A model whose replies are scripted, one per call, in order; it records what it was asked. The last reply repeats. */
function scripted(replies: ((options: CompleteOptions, call: number) => Partial<CompleteResult> | Record<string, unknown>)[], calls: CompleteOptions[] = []) {
  return async (options: CompleteOptions): Promise<CompleteResult> => {
    const index = Math.min(calls.length, replies.length - 1);
    calls.push(options);
    const reply = replies[index](options, calls.length);
    const base: CompleteResult = { text: null, json: null, usage: { tokens_in: 10, tokens_out: 5 }, duration_ms: 1, model_id: "stub", source: "sample-model" };
    if ("tool_calls" in reply && Array.isArray(reply.tool_calls)) return { ...base, ...(reply as Partial<CompleteResult>) };
    return { ...base, text: JSON.stringify(reply), json: reply as Record<string, unknown> };
  };
}

/** The run_query_ids the model was shown: in the user message's results and in every tool message of the history. */
function shownIds(options: CompleteOptions): string[] {
  const user = JSON.parse(options.user) as { results: { run_query_id: string }[] };
  const fromTools = (options.history ?? [])
    .filter((message): message is HistoryMessage & { role: "tool"; content: string } => message.role === "tool" && typeof message.content === "string")
    .map((message) => JSON.parse(message.content) as { run_query_id?: string })
    .map((content) => content.run_query_id)
    .filter((id): id is string => typeof id === "string");
  return [...user.results.map((result) => result.run_query_id), ...fromTools];
}

const queryLines = (lines: TraceInput[]) => lines.filter((line) => line.agent_name === "Query");
const analystLines = (lines: TraceInput[], action: string) => lines.filter((line) => line.agent_name === "Analyst" && line.action === action);

describe("the Analyst runs the planned queries", () => {
  it("runs the same query planned twice once: one query call, the second traced cached with the same run_query_id", async () => {
    const { lines, run } = runState();
    const outcome = await analyse(request([step("week_moves"), step("week_moves")]), { run });
    expect(outcome.ok).toBe(true);
    expect(run.usage.query_calls).toBe(1);
    const queries = queryLines(lines);
    expect(queries.map((line) => line.action)).toEqual(["query", "cached"]);
    expect(queries[1]).toMatchObject({ agent_name: "Query", action: "cached", status: "ok" });
    const [first] = Object.keys(run.store);
    expect(Object.keys(run.store)).toHaveLength(1);
    expect(queries[1].output_summary).toContain(first);
    // The model saw the result once.
    expect(outcome.results.map((result) => result.run_query_id)).toEqual([first]);
  });

  it("reuses a result run in an earlier round: round 2 makes no query call and cites the round-1 run_query_id", async () => {
    const { lines, run } = runState();
    const first = await analyse(request(weekPlan()), { run, round: 0 });
    const callsAfterRound1 = run.usage.query_calls;
    expect(callsAfterRound1).toBe(5);
    const second = await analyse(request(weekPlan(), { previous_findings: first.ok ? first.findings : [], feedback: "Cover BXPHARMA." }), { run, round: 1 });
    expect(run.usage.query_calls).toBe(callsAfterRound1);
    expect(queryLines(lines).filter((line) => line.action === "cached")).toHaveLength(5);
    expect(second.ok && first.ok && second.results.map((r) => r.run_query_id)).toEqual(first.ok ? first.results.map((r) => r.run_query_id) : null);
  });

  it("skips a planned step the guard refuses, traces it, lists it as a gap and goes on", async () => {
    const { lines, run } = runState();
    const outcome = await analyse(request([step("week_moves", { as_of: "2027-01-01" }), step("rule_findings")]), { run });
    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toEqual([expect.objectContaining({ query_id: "week_moves", reason: expect.stringMatching(/week_moves/) })]);
    expect(analystLines(lines, "step_skipped")).toEqual([expect.objectContaining({ status: "blocked" })]);
    expect(lines.filter((line) => line.agent_name === "Guard" && line.action === "block")).toHaveLength(1);
    expect(outcome.ok && outcome.gaps.some((gap) => gap.startsWith("week_moves") && gap.includes("did not run"))).toBe(true);
    expect(run.usage.query_calls).toBe(1);
  });

  it("returns the gaps code wrote as code_gaps, a subset of gaps that leaves out the model's own gap text", async () => {
    const { run } = runState();
    const modelGap = "The Analyst's own note: 37 broker lines were unclear.";
    const outcome = await analyse(request([step("week_moves", { as_of: "2027-01-01" }), step("rule_findings")]), { run, complete: scripted([() => ({ findings: [], gaps: [modelGap] })]) });
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.gaps).toContain(modelGap);
    expect(outcome.code_gaps).toEqual(codeGaps([], outcome.skipped));
    expect(outcome.code_gaps).not.toContain(modelGap);
    expect(outcome.code_gaps.every((gap) => outcome.gaps.includes(gap))).toBe(true);
  });
});

describe("the Analyst with the sample model", () => {
  it("writes a move finding for PORTFOLIO and one for BXPHARMA for 1 Oct, both citing week_moves, every finding cited with a numbers list", async () => {
    const { lines, run } = runState();
    const planned = await plan({ task: "explain_week", question: "Why did my portfolio move this week?", as_of: AS_OF }, { tracer: run.tracer, sampleMode: true });
    const outcome = await analyse(request(planned.steps, { focus: planned.focus }), { run });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const moves = outcome.results.find((result) => result.query_id === "week_moves")!;
    const portfolio = outcome.findings.find((f) => f.kind === "move" && f.subject === "PORTFOLIO");
    const bxpharma = outcome.findings.find((f) => f.kind === "move" && f.subject === "BXPHARMA");
    expect(portfolio?.cites).toEqual([moves.run_query_id]);
    expect(bxpharma?.cites).toEqual([moves.run_query_id]);
    expect(outcome.findings[0]).toBe(portfolio);
    expect(bxpharma?.claim).toMatch(/BXPHARMA fell 14\.9% over the week, -11\.9 points against its sector index \(stock-specific\)/);
    for (const f of outcome.findings) {
      expect(f.cites.length).toBeGreaterThan(0);
      expect(Array.isArray(f.numbers)).toBe(true);
    }
    expect(outcome.findings.some((f) => f.kind === "sector")).toBe(true);
    expect(outcome.findings.filter((f) => f.kind === "announcement").map((f) => f.subject).sort()).toEqual(["BXPHARMA", "SQURPHARMA"]);
    expect(outcome.findings.find((f) => f.kind === "announcement" && f.subject === "BXPHARMA")?.claim).toMatch(/after its earnings announcement on 2026-09-27/);
    expect(outcome.findings.some((f) => f.kind === "rule" && f.subject === "SQURPHARMA" && /25% position limit/.test(f.claim))).toBe(true);
    expect(outcome.findings.some((f) => f.kind === "rule" && /furthest from its target/.test(f.claim) && /30% target/.test(f.claim))).toBe(true);
    expect(outcome.findings.some((f) => /because of/i.test(f.claim))).toBe(false);
    // Every number is in the cited rows: the findings pass the citation guard against the run's store.
    expect(checkCitations(outcome.findings, run.store)).toEqual({ ok: true, failures: [] });
    // The empty dividends result is a gap, never a finding.
    expect(outcome.findings.some((f) => f.kind === "dividend")).toBe(false);
    expect(outcome.gaps.filter((gap) => gap.startsWith("dividends_between") && gap.includes("returned no rows"))).toHaveLength(1);
    const summary = analystLines(lines, "analyse");
    expect(summary).toEqual([expect.objectContaining({ target_agent: "Evaluator", status: "ok", model: "sample-model" })]);
    expect(summary[0].output_summary).toContain("move:PORTFOLIO");
    expect(lines.filter((line) => line.action === "model_call")).toHaveLength(2);
    expect(run.usage).toMatchObject({ model_calls: 1, query_calls: 5 });
  });

  it("says the GP dividend is owed for 24 Sep, and compares with last week's review when one was recalled", async () => {
    const { run } = runState();
    const memories: RecalledMemory[] = [{ id: "mem-review", tags: ["review", "2026-09-17"], content: "Week to 2026-09-17: the portfolio rose 0.9%, 1.2 points ahead of DSEX.", relevance: null }];
    const steps = [step("week_moves", { as_of: "2026-09-24" }), step("dividends_between", { from: "2026-09-17", to: "2026-09-24" })];
    const outcome = await analyse(request(steps, { as_of: "2026-09-24", memories }), { run });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const dividend = outcome.findings.find((f) => f.kind === "dividend");
    expect(dividend).toMatchObject({ subject: "GP" });
    expect(dividend?.claim).toMatch(/Tk 12\.5 a share on 240 shares, Tk 3000 in total/);
    expect(dividend?.claim).toMatch(/owed and not yet paid/);
    const lastWeek = outcome.findings.find((f) => f.claim.startsWith("Last week"));
    expect(lastWeek).toMatchObject({ kind: "move", subject: "PORTFOLIO", memory_ids: ["mem-review"] });
    expect(lastWeek?.cites).toEqual([outcome.results.find((r) => r.query_id === "week_moves")!.run_query_id]);
    expect(checkCitations(outcome.findings, run.store, memories)).toEqual({ ok: true, failures: [] });
  });

  it("puts an off-topic question in gaps, and adds a finding for the symbol the feedback names on a retry", async () => {
    const poem = await analyse(request(weekPlan(), { question: "Write me a poem about Dhaka." }), runState());
    expect(poem.ok && poem.gaps.some((gap) => gap.includes("Write me a poem about Dhaka."))).toBe(true);
    const advice = await analyse(request(weekPlan(), { question: "Should I sell BXPHARMA now?" }), runState());
    expect(advice.ok && advice.gaps.some((gap) => gap.includes("Should I sell"))).toBe(false);

    const { run } = runState();
    const retry = await analyse(request([...weekPlan(), step("fundamentals_latest", { symbol: "BXPHARMA", as_of: AS_OF })], { previous_findings: [], feedback: "Add BXPHARMA's latest quarters." }), { run, round: 1 });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const fundamentals = retry.findings.find((f) => f.kind === "fundamentals" && f.subject === "BXPHARMA");
    expect(fundamentals?.claim).toMatch(/EPS of 2\.3, 2\.05 and 1\.62 over its last three reported quarters, falling/);
    expect(checkCitations(retry.findings, run.store)).toEqual({ ok: true, failures: [] });
  });

  it("sends the prompt file as-is and one JSON user message with the task, question, as_of, trade, focus, memories, world, results, previous_findings and feedback", async () => {
    const calls: CompleteOptions[] = [];
    const { run } = runState();
    const previous = [finding("PORTFOLIO", ["q-old"])];
    await analyse(request([step("week_moves")], { previous_findings: previous, feedback: "Explain GP." }), { run, complete: scripted([() => done([])], calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toBe(readFileSync(path.join(__dirname, "../prompts/analyst.md"), "utf8"));
    expect(calls[0]).toMatchObject({ model: "main", json: true, agent: "Analyst" });
    const user = JSON.parse(calls[0].user) as Record<string, unknown>;
    expect(Object.keys(user)).toEqual(["task", "question", "as_of", "trade", "focus", "memories", "world", "results", "previous_findings", "feedback"]);
    expect(user).toMatchObject({ task: "explain_week", as_of: AS_OF, trade: null, world: [], previous_findings: previous, feedback: "Explain GP." });
    const results = user.results as { run_query_id: string; query_id: string; row_count: number; truncated: boolean; rows: unknown[] }[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ query_id: "week_moves", truncated: false });
    expect(results[0].rows).toHaveLength(results[0].row_count);
    // Round 1: previous_findings and feedback are null.
    const first: CompleteOptions[] = [];
    await analyse(request([step("week_moves")]), { run: runState().run, complete: scripted([() => done([])], first) });
    expect(JSON.parse(first[0].user)).toMatchObject({ previous_findings: null, feedback: null });
    // The tools are the task's catalogue as function definitions.
    const tools = toolsFor("explain_week");
    expect(tools.map((tool) => (tool as { function: { name: string } }).function.name)).toEqual(["week_moves", "sector_vs_stock", "announcements_between", "dividends_between", "fundamentals_latest", "journal_for_symbol", "rule_findings"]);
    expect(tools[0]).toMatchObject({ type: "function", function: { name: "week_moves", description: expect.stringContaining("PORTFOLIO"), parameters: { type: "object" } } });
    expect(calls[0].tools).toEqual(tools);
  });
});

describe("the Analyst with a stubbed model and tool calls", () => {
  it("runs a tool call through runQuery and the guard, traces it as tool_call, and a finding cites that run_query_id", async () => {
    const calls: CompleteOptions[] = [];
    const { lines, run } = runState();
    let fundamentalsId: string | undefined;
    const complete = scripted(
      [
        () => ({ tool_calls: [{ id: "call-1", name: "fundamentals_latest", arguments: { symbol: "BXPHARMA", as_of: AS_OF } }] }),
        (options) => {
          fundamentalsId = shownIds(options).at(-1);
          return done([finding("BXPHARMA", [fundamentalsId!], [{ value: 1.62, label: "eps bdt" }])]);
        },
      ],
      calls,
    );
    const outcome = await analyse(request([step("week_moves")]), { run, complete });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls).toHaveLength(2);
    expect(outcome).toMatchObject({ tool_rounds: 1, tool_calls: 1 });
    expect(run.usage).toMatchObject({ model_calls: 2, query_calls: 2 });
    // The guard allowed it, runQuery ran it and the Analyst traced the call.
    const guard = lines.filter((line) => line.agent_name === "Guard" && line.action === "allow" && line.input_summary.includes("fundamentals_latest"));
    expect(guard).toHaveLength(1);
    expect(queryLines(lines).filter((line) => line.action === "query" && line.input_summary.startsWith("fundamentals_latest"))).toHaveLength(1);
    const traced = analystLines(lines, "tool_call");
    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({ status: "ok", target_agent: "Query" });
    expect(traced[0].input_summary).toContain("fundamentals_latest");
    expect(traced[0].input_summary).toContain("BXPHARMA");
    // Round 2 saw the result as a tool message in the history, after the assistant's tool_calls message.
    expect(calls[1].history?.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(calls[1].history?.[1]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(fundamentalsId).toBeDefined();
    expect(run.store[fundamentalsId!]).toMatchObject({ query_id: "fundamentals_latest", params: { symbol: "BXPHARMA", as_of: AS_OF } });
    expect(outcome.findings[0].cites).toEqual([fundamentalsId]);
    expect(outcome.results.map((result) => result.query_id)).toEqual(["week_moves", "fundamentals_latest"]);
    expect(checkCitations(outcome.findings, run.store)).toEqual({ ok: true, failures: [] });
  });

  it("sends a tool call the guard blocks back as a tool message with the reason, without a crash", async () => {
    const calls: CompleteOptions[] = [];
    const { lines, run } = runState();
    const complete = scripted([() => ({ tool_calls: [{ id: "call-x", name: "no_such_query", arguments: {} }] }), (options) => done([finding("PORTFOLIO", [shownIds(options)[0]])])], calls);
    const outcome = await analyse(request([step("week_moves")]), { run, complete });
    expect(outcome.ok).toBe(true);
    expect(run.usage.query_calls).toBe(1);
    const block = lines.filter((line) => line.agent_name === "Guard" && line.action === "block");
    expect(block).toHaveLength(1);
    expect(block[0].why).toMatch(/Unknown query no_such_query/);
    const traced = analystLines(lines, "tool_call");
    expect(traced).toEqual([expect.objectContaining({ status: "blocked", why: expect.stringMatching(/no_such_query/) })]);
    const toolMessage = calls[1].history?.[1] as { role: string; tool_call_id: string; content: string };
    expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "call-x" });
    expect(JSON.parse(toolMessage.content)).toMatchObject({ error: expect.stringMatching(/Unknown query no_such_query/) });
  });

  it("refuses a registry query outside the task's tools and a call with bad arguments, each as a tool message, never run", async () => {
    const calls: CompleteOptions[] = [];
    const { lines, run } = runState();
    const complete = scripted(
      [
        () => ({ tool_calls: [{ id: "c-1", name: "what_if", arguments: { symbol: "GP", side: "buy", quantity: 10, as_of: AS_OF } }, { id: "c-2", name: "week_moves", arguments: {}, error: "bad_arguments" as const }] }),
        (options) => done([finding("PORTFOLIO", [shownIds(options)[0]])]),
      ],
      calls,
    );
    const outcome = await analyse(request([step("week_moves")]), { run, complete });
    expect(outcome.ok).toBe(true);
    expect(run.usage.query_calls).toBe(1);
    expect(analystLines(lines, "tool_call").map((line) => line.status)).toEqual(["blocked", "rejected"]);
    const history = calls[1].history as { role: string; content: string }[];
    expect(history.map((message) => message.role)).toEqual(["assistant", "tool", "tool"]);
    expect(JSON.parse(history[1].content)).toMatchObject({ error: "policy: Analyst may not run what_if for explain_week" });
    expect(JSON.parse(history[2].content)).toMatchObject({ error: expect.stringMatching(/not a JSON object/) });
  });

  it("stops a model that keeps calling tools after MAX_TOOL_ROUNDS (2), then calls once without tools", async () => {
    const calls: CompleteOptions[] = [];
    const { lines, run } = runState();
    const complete = scripted(
      [
        (options) => (options.tools === undefined ? done([finding("PORTFOLIO", [shownIds(options)[0]])]) : { tool_calls: [{ id: `call-${calls.length}`, name: "rule_findings", arguments: { as_of: AS_OF } }] }),
      ],
      calls,
    );
    const outcome = await analyse(request([step("week_moves")]), { run, complete });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.map((options) => options.tools !== undefined)).toEqual([true, true, false]);
    expect(outcome).toMatchObject({ tool_rounds: 2, tool_calls: 2 });
    expect(run.usage.model_calls).toBe(3);
    // The second rule_findings call came from the cache: one query call for it, two in all.
    expect(run.usage.query_calls).toBe(2);
    expect(queryLines(lines).filter((line) => line.action === "cached")).toHaveLength(1);
    expect(analystLines(lines, "tool_rounds_exhausted")).toHaveLength(1);
    expect(calls[2].history?.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
  });

  it("uses the planned results alone when the model returns no tool calls", async () => {
    const calls: CompleteOptions[] = [];
    const { run } = runState();
    const outcome = await analyse(request([step("week_moves")]), { run, complete: scripted([(options) => done([finding("PORTFOLIO", [shownIds(options)[0]])])], calls) });
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true, tool_rounds: 0, tool_calls: 0 });
    expect(run.usage).toMatchObject({ model_calls: 1, query_calls: 1 });
  });
});

describe("the Analyst on a bad or refused reply", () => {
  it("validates a good reply, filling what the model left out", () => {
    const parsed = analystReplySchema.parse({ findings: [{ kind: "rule", subject: "SQURPHARMA", claim: "The data shows SQURPHARMA is above the limit.", cites: ["q-1"] }] });
    expect(parsed.findings[0]).toEqual({ kind: "rule", subject: "SQURPHARMA", claim: "The data shows SQURPHARMA is above the limit.", numbers: [], cites: ["q-1"], verdict: null, proposed_fix: null, memory_ids: [] });
    expect(parsed.gaps).toEqual([]);
    expect(analystReplySchema.safeParse({ findings: [{ kind: "news", subject: "GP", claim: "x", cites: [] }] }).success).toBe(false);
    expect(analystReplySchema.safeParse({ findings: [{ kind: "thesis", subject: "j-1", claim: "x", cites: ["q"], verdict: "maybe" }] }).success).toBe(false);
  });

  it("ends as a structured BadJson error when the reply fails the schema, with the results it gathered", async () => {
    const { lines, run } = runState();
    const outcome = await analyse(request([step("week_moves")]), { run, complete: scripted([() => ({ findings: [{ kind: "news", subject: "GP", claim: "x", cites: ["q"] }], gaps: [] })]) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ type: "BadJson", recoverable: true });
    expect(outcome.error.message).toMatch(/findings\.0\.kind/);
    expect(outcome.results).toHaveLength(1);
    expect(analystLines(lines, "analyse")).toEqual([expect.objectContaining({ status: "rejected", target_agent: "Evaluator" })]);
  });

  it("ends as a structured Blocked error when the guard refuses a reply that tells the owner what to trade", async () => {
    const { lines, run } = runState();
    const bad = { findings: [{ ...finding("BXPHARMA", ["q"]), claim: "You should sell BXPHARMA now." }], gaps: [] };
    const outcome = await analyse(request([step("week_moves")]), { run, complete: scripted([() => bad]) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ type: "Blocked", recoverable: true });
    expect(outcome.error.message).toMatch(/tells the owner what to trade/);
    expect(lines.filter((line) => line.agent_name === "Guard" && line.action === "block")).toHaveLength(1);
    expect(analystLines(lines, "analyse")).toEqual([expect.objectContaining({ status: "blocked" })]);
  });

  it("ends as a structured BadJson error when the model answers with tool calls after tools were withdrawn", async () => {
    const { run } = runState();
    const outcome = await analyse(request([step("week_moves")]), { run, complete: scripted([() => ({ tool_calls: [{ id: "c", name: "rule_findings", arguments: { as_of: AS_OF } }] })]) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ type: "BadJson" });
    expect(outcome.error.message).toMatch(/no tools were offered/);
    expect(outcome.tool_rounds).toBe(2);
  });

  it("throws BudgetExhaustedError when no model call is left, before calling the model", async () => {
    const tight = loadConfig({ SAMPLE_MODE: "true", MAX_MODEL_CALLS: "1" }, () => {});
    const { run } = runState({ config: tight });
    await analyse(request([step("week_moves")]), { run });
    const calls: CompleteOptions[] = [];
    await expect(analyse(request([step("week_moves")]), { run, complete: scripted([() => done([])], calls) })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(0);
  });
});
