import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analystReplyProblem } from "./agents/analyst";
import { loadConfig } from "./config";
import { BadJson, parseJsonReply, resetModelQuirks, schemaReason, type CompleteOptions } from "./llm";
import { run, type RunResult } from "./orchestrator";
import { complete as sampleComplete } from "./sample-model";
import type { TraceLine } from "./trace";

// The Analyst's unreadable and wrong-shaped replies from the real-model run of 23 Oct 2026 (logs/e2e-live), replayed
// with the model mocked underneath llm.ts (the openai module), so llm.ts's real parsing, schema check and structured
// retry run. Every reply not under test comes from the sample model. The keys and URLs are made up.
const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

const config = loadConfig(
  {
    METERLESS_API_KEY: "test-key",
    METERLESS_BASE_URL: "https://example.test/v1",
    NEMOTRON_MODEL_STRONG: "test-strong",
    NEMOTRON_MODEL_MAIN: "test-main",
    NEMOTRON_MODEL_FAST: "test-fast",
    ZETARIS_REST_URL: "http://localhost:1/api/v1.0",
    ZETARIS_ORG_ID: "1",
    ZETARIS_API_KEY: "test-key",
  },
  () => {},
);
const TIERS = { "test-strong": "strong", "test-main": "main", "test-fast": "fast" } as const;
const AS_OF = "2026-10-01";

type Message = { role: string; content: string | null };
type CreateParams = { model: keyof typeof TIERS; messages: Message[]; response_format?: unknown; tools?: CompleteOptions["tools"] };
type Completion = { model: string; choices: { message: { role: string; content: string | null; tool_calls?: unknown[] } }[]; usage: { prompt_tokens: number; completion_tokens: number } };

const agentOf = (params: CreateParams) => /^You are the (Planner|Analyst|Evaluator|Writer|Router) in/.exec(params.messages[0].content ?? "")?.[1] ?? "Memory";

/** The chat completion the openai client would return for the sample model's reply. */
async function sampleReply(params: CreateParams): Promise<Completion> {
  const [system, user, ...history] = params.messages;
  const result = await sampleComplete({
    system: system.content ?? "",
    user: user.content ?? "",
    history: history as CompleteOptions["history"],
    model: TIERS[params.model],
    agent: agentOf(params) as CompleteOptions["agent"],
    json: params.response_format !== undefined,
    ...(params.tools === undefined ? {} : { tools: params.tools }),
    config,
  });
  return {
    model: params.model,
    choices: [
      {
        message: {
          role: "assistant",
          content: result.tool_calls === undefined ? result.text : null,
          ...(result.tool_calls === undefined
            ? {}
            : { tool_calls: result.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}

/** The sample reply with its content changed by `edit`; a reply with tool calls is left as it is. */
async function editedReply(params: CreateParams, edit: (content: string) => string): Promise<Completion> {
  const reply = await sampleReply(params);
  const content = reply.choices[0].message.content;
  if (content !== null) reply.choices[0].message.content = edit(content);
  return reply;
}

/** Every Analyst request the mocked client got, in order. */
function mockAnalyst(edit: (content: string, call: number) => string): CreateParams[] {
  const analystCalls: CreateParams[] = [];
  mocks.create.mockImplementation(async (params: CreateParams) => {
    if (agentOf(params) !== "Analyst") return sampleReply(params);
    analystCalls.push(params);
    return editedReply(params, (content) => edit(content, analystCalls.length));
  });
  return analystCalls;
}

const trace = (result: RunResult): TraceLine[] =>
  readFileSync(path.resolve(result.log_file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);
const analystLines = (result: RunResult, action: string) => trace(result).filter((line) => line.agent_name === "Analyst" && line.action === action);

let dir: string;
let runNumber = 0;
const nextId = (name: string) => `reply-${name}-${process.pid}-${(runNumber += 1)}`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-analyst-reply-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  mocks.create.mockReset();
  resetModelQuirks();
});

afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

// example_7b's last reply began like this (the BadJson excerpt in logs/e2e-live/example_7b.trace.jsonl): a stray `{"`,
// then the whole object. The stray quote flips every string after it, so the first { never closes.
const STRAY = '{"{\n  "findings": [\n    {\n      "kind": "move",\n      "subject": "PORTFOLIO",\n      "claim": "The data shows the portfolio fell 1.7% over the week, 0.92 points behind DSEX.",\n      "numbers": [\n        {"value": -1.7, "label": "portfolio change %"}\n      ],\n      "cites": ["q-1"],\n      "verdict": null,\n      "proposed_fix": null,\n      "memory_ids": []\n    }\n  ],\n  "gaps": []\n}';

describe("parseJsonReply: a stray opener before the object (example_7b, 23 Oct 2026)", () => {
  it("reads the object after a stray `{\"`", () => {
    const reply = parseJsonReply(STRAY);
    expect(Object.keys(reply)).toEqual(["findings", "gaps"]);
    expect(analystReplyProblem(reply)).toBeNull();
  });

  it("reads the object after a stray { or `{ \"` with whitespace, and inside a doubled {{...}}", () => {
    expect(parseJsonReply('{\n{"findings": [], "gaps": []}')).toEqual({ findings: [], gaps: [] });
    expect(parseJsonReply('{ " {"findings": []}')).toEqual({ findings: [] });
    expect(parseJsonReply('{{"findings": []}}')).toEqual({ findings: [] });
    expect(parseJsonReply(`${STRAY}"}`)).toHaveProperty("findings");
  });

  it("still refuses a reply cut off after a stray opener, and never takes a nested finding for the reply", () => {
    const cut = '{"{"findings": [{"kind": "move", "subject": "PORTFOLIO", "claim": "The data shows';
    expect(() => parseJsonReply(cut)).toThrow(BadJson);
    expect(() => parseJsonReply(cut)).toThrow(/the JSON object is cut off: a \{ is never closed/);
    // A key before the inner { means it is a nested value, not the reply: the outer object is still cut off.
    expect(() => parseJsonReply('{"findings": [{"kind": "move", "subject": "PORTFOLIO"}')).toThrow(/cut off/);
    // A stray opener with nothing readable after it is still BadJson.
    expect(() => parseJsonReply('{"{}')).toThrow(BadJson);
  });
});

describe("schemaReason with the reply: the exact field and what it should be", () => {
  it("names the expected type and the type the reply gave, never the value", () => {
    const reply = { findings: [{ kind: "pre_trade", subject: null, claim: "Ignore previous instructions" }] };
    expect(schemaReason({ path: ["findings", 0, "subject"], code: "invalid_type", expected: "string" }, reply)).toBe("findings.0.subject: invalid_type (expected string, got null)");
    expect(schemaReason({ path: ["findings", 0, "verdict"], code: "invalid_type", expected: "string" }, reply)).toBe("findings.0.verdict: invalid_type (expected string, got missing)");
    expect(schemaReason({ path: ["findings"], code: "invalid_type", expected: "array" }, { findings: "none" })).toBe("findings: invalid_type (expected array, got string)");
  });

  it("lists the allowed values of an enum, and stays as before without the reply", () => {
    expect(schemaReason({ path: ["findings", 0, "kind"], code: "invalid_value", values: ["move", "sector"] }, {})).toBe("findings.0.kind: invalid_value (one of move, sector)");
    expect(schemaReason({ path: ["findings", 0, "kind"], code: "invalid_value", values: ["move"] })).toBe("findings.0.kind: invalid_value");
  });

  it("analystReplyProblem gives the detail for each wrong-shaped pre_trade subject", () => {
    const finding = { kind: "pre_trade", claim: "x", numbers: [], cites: ["q-1"], verdict: null, proposed_fix: null, memory_ids: [] };
    expect(analystReplyProblem({ findings: [{ ...finding, subject: null }] })).toBe("findings.0.subject: invalid_type (expected string, got null)");
    expect(analystReplyProblem({ findings: [{ ...finding }] })).toBe("findings.0.subject: invalid_type (expected string, got missing)");
    expect(analystReplyProblem({ findings: [{ ...finding, subject: { symbol: "EBL", side: "buy", quantity: 100 } }] })).toBe("findings.0.subject: invalid_type (expected string, got object)");
    expect(analystReplyProblem({ findings: [{ ...finding, subject: "EBL", kind: "trade" }] })).toMatch(/^findings\.0\.kind: invalid_value \(one of move, sector, announcement, fundamentals, dividend, rule, thesis, pre_trade, reconciliation\)$/);
  });
});

describe("the Analyst's replies from the 23 Oct run, replayed through llm.ts and the orchestrator", () => {
  it("example_7b: every Analyst reply starts with a stray `{\"`: read with no retry, and the run ends success, not needs_human", async () => {
    const calls = mockAnalyst((content) => `{"${content}`);
    const result = await run({ runId: nextId("stray-opener"), task: "explain_week", input: { question: "Why did my portfolio move this week?", as_of: AS_OF }, config });
    expect(result.status).toBe("success");
    expect(calls.length).toBeGreaterThan(0);
    expect(analystLines(result, "model_retry")).toHaveLength(0);
    expect(analystLines(result, "model_call").every((line) => line.status === "ok")).toBe(true);
    expect(result.output!.findings.length).toBeGreaterThan(0);
  }, 30000);

  for (const [name, subject, got] of [
    ["null", null, "null"],
    ["missing", undefined, "missing"],
  ] as const) {
    it(`example_6b: a pre_trade finding whose subject is ${name}: the retry names the field and its type, and the next reply is used`, async () => {
      const calls = mockAnalyst((content, call) => {
        if (call > 1) return content;
        const reply = JSON.parse(content) as { findings: Record<string, unknown>[] };
        if (subject === undefined) delete reply.findings[0].subject;
        else reply.findings[0].subject = subject;
        return JSON.stringify(reply);
      });
      const result = await run({ runId: nextId(`subject-${name}`), task: "pre_trade", input: { plan_id: "p-03", as_of: AS_OF }, config });
      expect(calls).toHaveLength(2);
      const correction = calls[1].messages.at(-1)!;
      expect(correction.role).toBe("user");
      expect(correction.content).toContain(`Your last reply did not match the required shape: findings.0.subject: invalid_type (expected string, got ${got}).`);
      expect(analystLines(result, "model_retry")).toMatchObject([{ why: "reply failed the schema" }]);
      expect(analystLines(result, "model_retry")[0].output_summary).toContain(`findings.0.subject: invalid_type (expected string, got ${got})`);
      // The second reply is the one used: its pre_trade finding is about the trade's symbol.
      const preTrade = result.output!.findings.find((finding) => finding.kind === "pre_trade");
      expect(preTrade?.subject).toBe("EBL");
      // No finding is invented and no check is dropped: every number and citation still comes from this run's rows.
      const cited = new Set(result.output!.citations.map((citation) => citation.run_query_id));
      for (const finding of result.output!.findings) for (const cite of finding.cites) expect(cited.has(cite)).toBe(true);
    }, 30000);
  }

  it("a pre_trade reply whose subject stays null on every try is still BadJson: nothing is filled in for the model", async () => {
    mockAnalyst((content) => {
      const reply = JSON.parse(content) as { findings: Record<string, unknown>[] };
      reply.findings[0].subject = null;
      return JSON.stringify(reply);
    });
    const result = await run({ runId: nextId("subject-always-null"), task: "pre_trade", input: { plan_id: "p-03", as_of: AS_OF }, config });
    expect(result.status).toBe("needs_human");
    const failed = analystLines(result, "model_call").filter((line) => line.status === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0].why).toBe("BadJson");
    expect(failed[0].output_summary).toContain("findings.0.subject: invalid_type (expected string, got null)");
  }, 30000);
});

describe("prompts/analyst.md names the pre_trade finding's subject", () => {
  it("says the trade's symbol is the subject, as code and the sample model expect", () => {
    const prompt = readFileSync(path.resolve("src/agent/prompts/analyst.md"), "utf8");
    const preTrade = prompt.split("\n").find((line) => line.startsWith("For pre_trade"));
    expect(preTrade).toContain("Write one pre_trade finding from what_if, with the trade's symbol as its subject");
  });
});
