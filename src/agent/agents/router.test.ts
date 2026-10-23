import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { BadJson, type CompleteOptions, type CompleteResult } from "../llm";
import { run, type RunResult } from "../orchestrator";
import type { TraceLine } from "../trace";
import { route, routerInput, routerReplySchema } from "./router";

// The sample model answers every agent; a test that needs a different Router reply overrides that agent only. The
// override wraps the real sample model, so llm.ts still writes the model_call line and counts the call.
type Actual = (options: CompleteOptions) => Promise<CompleteResult>;
type Override = (options: CompleteOptions, actual: Actual) => Promise<CompleteResult | null>;
const stubs = vi.hoisted(() => ({ override: null as Override | null }));

vi.mock("../sample-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sample-model")>();
  const complete = async (options: CompleteOptions): Promise<CompleteResult> => {
    const override = stubs.override;
    if (override !== null) {
      const result = await override(options, actual.complete);
      if (result !== null) return result;
    }
    return actual.complete(options);
  };
  return { ...actual, complete };
});

const config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const REAL_SYMBOLS = ["GP", "ROBI", "BRACBANK", "EBL", "CITYBANK", "SQURPHARMA", "BXPHARMA", "RENATA", "BATBC", "OLYMPIC", "LHBL", "HEIDELBCEM", "UPGDCL", "SUMITPOWER", "WALTONHIL"];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-router-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  stubs.override = null;
});
afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  stubs.override = null;
  await rm(dir, { recursive: true, force: true });
});

/** Replaces the Router's reply (or throws for it) and leaves every other agent on the sample model. */
function stubRouter(reply: Record<string, unknown> | Error): void {
  stubs.override = async (options, actual) => {
    if (options.agent !== "Router") return null;
    if (reply instanceof Error) throw reply;
    const result = await actual(options);
    return { ...result, json: reply, text: JSON.stringify(reply) };
  };
}

const traceOf = (runId: string): TraceLine[] =>
  readFileSync(path.resolve("logs", `trace-${runId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceLine);

const free = (runId: string, question: string, extra: Record<string, unknown> = {}, cfg = config): Promise<RunResult> =>
  run({ runId, input: { question, ...extra }, sampleMode: true, config: cfg });

const routeLine = (runId: string) => traceOf(runId).find((line) => line.agent_name === "Router" && line.action === "route");

describe("the sample Router", () => {
  it("routes a symbol, a side and a quantity to pre_trade", async () => {
    const result = await free("router-test-pre-trade", "Would buying 70 WALTONHIL break my rules?", { as_of: AS_OF });
    expect(result.task).toBe("pre_trade");
    expect(result.status).not.toBe("error");
    expect(routeLine("router-test-pre-trade")?.output_summary).toContain("trade=buy 70 WALTONHIL");
  });

  it("routes a question with no task to explain_week for the last trading day when as_of is missing", async () => {
    const result = await free("router-test-no-as-of", "Why did I lose money this week?");
    expect(result.task).toBe("explain_week");
    expect(result.status).toBe("success");
    const start = traceOf("router-test-no-as-of").find((line) => line.action === "run_start");
    expect(start?.input_summary).toContain(`as_of=${AS_OF}`);
  });

  it("routes advice with no quantity to explain_week, where the advice is declined, and never to pre_trade", async () => {
    const result = await free("router-test-advice", "Should I sell BXPHARMA now?", { as_of: AS_OF });
    expect(result.task).toBe("explain_week");
    expect(result.output?.declined_advice).toBe(true);
  });

  it("is the run's first model call, and its call counts in usage", async () => {
    const result = await free("router-test-first-call", "Why did I lose money this week?", { as_of: AS_OF });
    const calls = traceOf("router-test-first-call").filter((line) => line.action === "model_call");
    expect(calls[0].agent_name).toBe("Router");
    expect(calls.filter((line) => line.agent_name === "Router")).toHaveLength(1);
    expect(result.usage.model_calls).toBe(calls.reduce((n, line) => n + (line.usage?.model_calls ?? 0), 0));
    // The lines before the Router has picked carry task "router", the Router's own lines included; setTask names the routed
    // one on the later lines without truncating the file.
    const lines = traceOf("router-test-first-call");
    expect(lines[0].task).toBe("router");
    expect(lines.filter((line) => line.agent_name === "Router").every((line) => line.task === "router")).toBe(true);
    expect(lines.find((line) => line.action === "run_start")?.task).toBe("explain_week");
    expect(lines.every((line) => typeof line.task === "string")).toBe(true);
  });

  it("counts the Router's call in MAX_MODEL_CALLS", async () => {
    const one = loadConfig({ SAMPLE_MODE: "true", MAX_MODEL_CALLS: "1" }, () => {});
    const result = await free("router-test-budget", "Why did I lose money this week?", { as_of: AS_OF }, one);
    expect(result.status).toBe("needs_human");
    expect(result.output?.stop_reason).toBe("model_calls");
    expect(result.usage.model_calls).toBe(1);
  });

  it.each([
    ["Do my reasons for buying still hold?", "thesis_check"],
    ["Does my broker file match the ledger?", "reconcile"],
    ["Does the bank statement agree?", "reconcile"],
    ["What about the market?", "explain_week"],
    ["Should I hold WALTONHIL?", "explain_week"],
    ["Is it time to buy WALTONHIL?", "explain_week"],
  ])("routes %j to %s", async (question, task) => {
    const outcome = await route(
      { question, instruments: [{ symbol: "WALTONHIL", name: "Walton Hi-Tech Industries" }] },
      { tracer: { runId: "x", file: "x", setTask: () => undefined, log: vi.fn() } as never, config, sampleMode: true },
    );
    expect(outcome.task).toBe(task);
  });
});

describe("the Router's reply is checked in code", () => {
  it("turns a pre_trade for a symbol that is not in instruments.json into an InvalidInput error, with the Router call counted", async () => {
    stubRouter({ task: "pre_trade", trade: { symbol: "NOSUCHSYM", side: "buy", quantity: 10 } });
    const result = await free("router-test-unknown-symbol", "Would buying 10 NOSUCHSYM break my rules?", { as_of: AS_OF });
    expect(result.status).toBe("error");
    expect(result.error?.type).toBe("InvalidInput");
    expect(result.usage.model_calls).toBe(1);
    expect(result.task).toBe("pre_trade");
  });

  it("turns a quantity that is not a positive whole number into an InvalidInput error", async () => {
    stubRouter({ task: "pre_trade", trade: { symbol: "WALTONHIL", side: "buy", quantity: 2.5 } });
    const result = await free("router-test-bad-quantity", "Would buying 2.5 WALTONHIL break my rules?", { as_of: AS_OF });
    expect(result.error?.type).toBe("InvalidInput");
  });

  it("routes a reply that fails the schema to explain_week, traced as an invalid router reply, without ending the run", async () => {
    stubRouter({ task: "write_a_poem" });
    const result = await free("router-test-bad-schema", "Why did I lose money this week?", { as_of: AS_OF });
    expect(result.status).not.toBe("error");
    expect(result.task).toBe("explain_week");
    const line = routeLine("router-test-bad-schema");
    expect(line?.why).toBe("invalid router reply");
    expect(line?.status).toBe("fallback");
  });

  it("routes an unparseable reply (BadJson after llm.ts's retry) to explain_week and still counts the call", async () => {
    stubRouter(new BadJson("not json at all"));
    const result = await free("router-test-bad-json", "Why did I lose money this week?", { as_of: AS_OF });
    expect(result.status).not.toBe("error");
    expect(result.task).toBe("explain_week");
    expect(routeLine("router-test-bad-json")?.why).toBe("invalid router reply");
    expect(result.usage.model_calls).toBeGreaterThan(traceOf("router-test-bad-json").filter((line) => line.action === "model_call" && line.agent_name !== "Router").reduce((n, line) => n + (line.usage?.model_calls ?? 0), 0));
  });

  it("accepts a Router pre_trade only when the question holds a number or a plan_id is set", async () => {
    stubRouter({ task: "pre_trade", trade: { symbol: "WALTONHIL", side: "buy", quantity: 70 } });
    const none = await free("router-test-no-quantity", "Would buying Walton break my rules?", { as_of: AS_OF });
    expect(none.task).toBe("explain_week");
    expect(routeLine("router-test-no-quantity")?.why).toBe("no quantity");

    stubRouter({ task: "pre_trade", plan_id: "p-02" });
    const plan = await free("router-test-plan", "What would this trade do to my rules?", { as_of: AS_OF, plan_id: "p-02" });
    expect(plan.task).toBe("pre_trade");
    expect(plan.status).toBe("needs_human");
    // The review queue reads why a run waits from the run_end line alone.
    const end = traceOf("router-test-plan").find((entry) => entry.action === "run_end");
    expect(end).toMatchObject({ status: "needs_human", escalation_rule: "sector_target", task: "pre_trade" });
  });

  it("routes a pre_trade reply with nothing to preview to explain_week", async () => {
    stubRouter({ task: "pre_trade" });
    const result = await free("router-test-no-trade", "Would buying 70 of them break my rules?", { as_of: AS_OF });
    expect(result.task).toBe("explain_week");
    expect(routeLine("router-test-no-trade")?.why).toBe("invalid router reply");
  });

  it("never calls the Router for a request with a task, or for input that fails validation", async () => {
    const withTask = await run({ runId: "router-test-with-task", task: "explain_week", input: { question: "Why did I lose money this week?", as_of: AS_OF }, sampleMode: true, config });
    expect(withTask.status).toBe("success");
    expect(traceOf("router-test-with-task").some((line) => line.agent_name === "Router")).toBe(false);

    for (const [id, input] of [
      ["router-test-empty", { question: "", as_of: AS_OF }],
      ["router-test-bad-date", { question: "Why did I lose money?", as_of: "2025-01-01" }],
    ] as const) {
      const result = await free(id, input.question, { as_of: input.as_of });
      expect(result.error?.type).toBe("InvalidInput");
      expect(result.usage.model_calls).toBe(0);
      expect(traceOf(id).some((line) => line.agent_name === "Router")).toBe(false);
    }
  });
});

describe("the Router's schema, input and prompt", () => {
  it("accepts the shapes the prompt defines and refuses a task it does not name", () => {
    expect(routerReplySchema.safeParse({ task: "explain_week" }).success).toBe(true);
    expect(routerReplySchema.safeParse({ task: "pre_trade", trade: { symbol: "ACMEPHARMA", side: "sell", quantity: 5 }, plan_id: null }).success).toBe(true);
    expect(routerReplySchema.safeParse({ task: "briefing" }).success).toBe(false);
    expect(routerReplySchema.safeParse({ task: "pre_trade", trade: { symbol: "X", side: "hold", quantity: 1 } }).success).toBe(false);
  });

  it("gives the model the question, the plan id, the instruments and the tasks, and nothing from the ledger", () => {
    const input = routerInput({ question: "q", instruments: [{ symbol: "ACMEPHARMA", name: "Acme" }] });
    expect(Object.keys(input).sort()).toEqual(["plan_id", "question", "symbols", "tasks"]);
    expect(input.tasks.map((task) => task.id)).toEqual(["explain_week", "thesis_check", "pre_trade", "reconcile"]);
  });

  it("ends with an Examples section of three cases on made-up data", () => {
    const prompt = readFileSync(path.resolve("src/agent/prompts/router.md"), "utf8");
    const headings = prompt.match(/^## .*$/gm) ?? [];
    expect(headings.at(-1)).toBe("## Examples");
    const examples = prompt.slice(prompt.indexOf("## Examples"));
    expect(examples.match(/^Example \d/gm)).toHaveLength(3);
    expect(examples).toContain("ACMEPHARMA");
    for (const symbol of REAL_SYMBOLS) expect(examples).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    expect(examples).not.toMatch(/2026-\d\d-\d\d/);
  });
});
