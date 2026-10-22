import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DISCLAIMER } from "./agents/writer";
import { loadConfig } from "./config";
import type { CompleteOptions, CompleteResult } from "./llm";
import { errorOf, run, type RunInput, type RunResult } from "./orchestrator";
import { branchOnWhatIf, fixedPlan, resolveTrade } from "./pre-trade";
import { QueryError } from "./queries";
import type { TraceLine } from "./trace";

// pre_trade as of 2026-10-01 with the sample model, on a temporary copy of data/ through TRADEFLOW_DATA_DIR. The
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

let dir: string;
let p02: RunResult;
let p03: RunResult;
let p02Calls: CompleteOptions[];

const trace = (result: RunResult): TraceLine[] =>
  readFileSync(path.resolve(result.log_file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);

const preTrade = (runId: string, input: RunInput) => run({ runId, task: "pre_trade", input: { as_of: AS_OF, ...input }, sampleMode: true, config });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-pretrade-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  calls.list.length = 0;
  p02 = await preTrade("pretrade-p02", { plan_id: "p-02" });
  p02Calls = [...calls.list];
  p03 = await preTrade("pretrade-p03", { plan_id: "p-03" });
}, 60_000);

afterAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("pre_trade, sample model", () => {
  it("escalates plan p-02 (buy 70 WALTONHIL at 1,179.60): needs_human, rule sector_target, new_findings [sector_target]", () => {
    expect(p02.status).toBe("needs_human");
    expect(p02.error).toBeNull();
    const output = p02.output!;
    expect(output.needs_human).toBe(true);
    expect(output.partial).toBe(false);
    expect(output.stop_reason).toBeNull();
    expect(output.new_findings).toEqual(["sector_target"]);
    expect(output.escalation).toMatchObject({ rule: "sector_target" });
    expect(output.escalation?.sector).toEqual(expect.any(String));
    expect(output.escalation?.message).toEqual(expect.any(String));
    expect(output.escalation?.message.length).toBeGreaterThan(0);
    expect(typeof output.escalation?.before).toBe("number");
    expect(typeof output.escalation?.after).toBe("number");
    // The Writer opens with the escalation sentence, built from the rule's own message.
    expect(output.summary.startsWith(`This trade would break sector_target: ${output.escalation?.message} Nothing has been saved; the decision is yours.`)).toBe(true);
    expect(output.review_markdown.trimEnd().split("\n").at(-1)).toBe(DISCLAIMER);
  });

  it("reviews plan p-03 (buy 300 EBL at 26.60): success, no new findings, the weights before and after", () => {
    expect(p03.status).toBe("success");
    const output = p03.output!;
    expect(output.new_findings).toEqual([]);
    expect(output.escalation).toBeNull();
    expect(output.needs_human).toBe(false);
    expect(output.findings.some((finding) => finding.kind === "pre_trade")).toBe(true);
    expect(output.summary).toMatch(/would go from [\d.]+% to [\d.]+%/);
    expect(output.review_markdown.trimEnd().split("\n").at(-1)).toBe(DISCLAIMER);
    for (const finding of output.findings) expect(finding.cites.length).toBeGreaterThan(0);
  });

  it("traces the fixed plan as one Orchestrator line listing the five queries, and never calls the Planner", () => {
    const lines = trace(p02);
    const fixed = lines.filter((line) => line.agent_name === "Orchestrator" && line.action === "fixed_plan");
    expect(fixed).toHaveLength(1);
    const text = `${fixed[0].output_summary} ${fixed[0].why}`;
    for (const id of ["what_if", "journal_for_symbol", "rule_findings", "announcements_between", "fundamentals_latest"]) expect(text).toContain(id);
    expect(lines.filter((line) => line.agent_name === "Planner")).toEqual([]);
    expect(p02Calls.map((call) => call.agent)).not.toContain("Planner");
    expect(p02Calls.map((call) => call.agent)).toEqual(expect.arrayContaining(["Analyst", "Evaluator", "Writer"]));
    // The Analyst is offered no tools: code ran every query.
    for (const call of p02Calls.filter((c) => c.agent === "Analyst")) expect(call.tools ?? []).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ agent_name: "Orchestrator", action: "run_end", status: "needs_human" });
    expect(lines.some((line) => line.action === "branch" && line.escalation_rule === "sector_target")).toBe(true);
  });

  it("returns InvalidInput with zero model calls for an unknown symbol", async () => {
    const result = await preTrade("pretrade-notreal", { trade: { symbol: "NOTREAL", side: "buy", quantity: 10 } });
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ type: "InvalidInput", recoverable: false });
    expect(result.usage.model_calls).toBe(0);
    expect(result.output).toBeNull();
  });

  it("returns InvalidInput with zero model calls for both trade and plan_id, neither, a bad quantity and a closed plan", async () => {
    const both = await preTrade("pretrade-both", { plan_id: "p-03", trade: { symbol: "EBL", side: "buy", quantity: 10 } });
    const neither = await preTrade("pretrade-neither", {});
    const fraction = await preTrade("pretrade-fraction", { trade: { symbol: "EBL", side: "buy", quantity: 2.5 } });
    const zero = await preTrade("pretrade-zero", { trade: { symbol: "EBL", side: "buy", quantity: 0 } });
    const executed = await preTrade("pretrade-executed", { plan_id: "p-01" });
    for (const result of [both, neither, fraction, zero, executed]) {
      expect(result.error).toMatchObject({ type: "InvalidInput" });
      expect(result.usage).toMatchObject({ model_calls: 0, query_calls: 0 });
    }
    expect(neither.error?.message).toContain("usage");
  });

  it("maps a what_if QueryError (no price, unknown symbol) to InvalidInput, never Internal", () => {
    for (const type of ["no_price", "unknown_symbol"] as const) {
      expect(errorOf(new QueryError(type, `a ${type} error`))).toEqual({ type: "InvalidInput", message: `a ${type} error`, recoverable: false });
    }
    expect(errorOf(new Error("boom")).type).toBe("Internal");
  });
});

describe("pre-trade helpers", () => {
  const known = { hasSymbol: (symbol: string) => symbol === "EBL", plans: [] };

  it("resolves a trade and upper-cases the symbol", () => {
    expect(resolveTrade({ trade: { symbol: " ebl ", side: "sell", quantity: 5 } }, known)).toEqual({ ok: true, trade: { symbol: "EBL", side: "sell", quantity: 5 }, plan_id: null });
  });

  it("builds the five fixed steps with a why each, announcements over the last 30 days", () => {
    const steps = fixedPlan({ symbol: "EBL", side: "buy", quantity: 10 }, "2026-10-01");
    expect(steps.map((step) => step.query_id)).toEqual(["what_if", "journal_for_symbol", "rule_findings", "announcements_between", "fundamentals_latest"]);
    expect(steps.every((step) => step.why.length > 0)).toBe(true);
    expect(steps[3].params).toEqual({ from: "2026-09-01", to: "2026-10-01", symbol: "EBL" });
  });

  it("branches on new_finding rows only", () => {
    const none = branchOnWhatIf({ rows: [{ row_type: "trade" }, { row_type: "holding", symbol: "EBL" }] });
    expect(none).toEqual({ new_findings: [], escalation: null });
    const some = branchOnWhatIf({
      rows: [
        { row_type: "sector", sector: "Bank", weight_before_pct: 20, weight_after_pct: 31 },
        { row_type: "new_finding", kind: "sector_target", subject: "Bank", message: "Bank is over." },
        { row_type: "new_finding", kind: "sector_target", subject: "Cement", message: "Cement is under." },
      ],
    });
    expect(some.new_findings).toEqual(["sector_target"]);
    expect(some.escalation).toEqual({ rule: "sector_target", sector: "Bank", before: 20, after: 31, message: "Bank is over." });
  });
});
