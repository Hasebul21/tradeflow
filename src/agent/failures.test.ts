import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { resetModelQuirks, type CompleteOptions, type CompleteResult } from "./llm";
import { run, type RunResult } from "./orchestrator";
import { complete as sampleComplete } from "./sample-model";
import type { TraceLine } from "./trace";

// Failure injection. The model client is mocked underneath llm.ts (the openai module), so llm.ts's real fallback,
// retry, timeout and error mapping run. A mocked model that is not under test hands the request to the sample
// model's complete(), so every agent gets a valid reply. Zetaris is mocked at the wire (fetch), so the real client
// maps 401, 5xx and timeouts. No test touches the network: the keys and URLs below are made up.
const mocks = vi.hoisted(() => ({ create: vi.fn(), sampleCalls: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

// Counts every call that reaches the sample model, so a test can show that none did.
vi.mock("./sample-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sample-model")>();
  return {
    ...actual,
    complete: async (options: CompleteOptions): Promise<CompleteResult> => {
      mocks.sampleCalls();
      return actual.complete(options);
    },
  };
});

const REAL_KEYS = {
  METERLESS_API_KEY: "test-key",
  METERLESS_BASE_URL: "https://example.test/v1",
  NEMOTRON_MODEL_STRONG: "test-strong",
  NEMOTRON_MODEL_MAIN: "test-main",
  NEMOTRON_MODEL_FAST: "test-fast",
  ZETARIS_REST_URL: "http://localhost:1/api/v1.0",
  ZETARIS_ORG_ID: "1",
  ZETARIS_API_KEY: "test-key",
};
const realConfig = (extra: Record<string, string> = {}) => loadConfig({ ...REAL_KEYS, ...extra }, () => {});
const sampleConfig = (extra: Record<string, string> = {}) => loadConfig(extra, () => {});

const AS_OF = "2026-10-01";
const QUESTION = "Why did my portfolio move this week?";
const TIERS = { "test-strong": "strong", "test-main": "main", "test-fast": "fast" } as const;

type CreateParams = {
  model: keyof typeof TIERS;
  messages: { role: string; content: string }[];
  response_format?: unknown;
  tools?: CompleteOptions["tools"];
};
type CreateOptions = { timeout?: number; signal?: AbortSignal };

/** The chat completion the openai client would return for a sample model reply. */
async function sampleReply(params: CreateParams, config: ReturnType<typeof realConfig>) {
  const [system, user, ...history] = params.messages;
  const agent = /^You are the (Planner|Analyst|Evaluator|Writer) in/.exec(system.content)?.[1] ?? "Memory";
  const result = await sampleComplete({
    system: system.content,
    user: user.content,
    history: history as CompleteOptions["history"],
    model: TIERS[params.model],
    agent: agent as CompleteOptions["agent"],
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
    usage: { prompt_tokens: result.usage?.tokens_in ?? 0, completion_tokens: result.usage?.tokens_out ?? 0 },
  };
}

/**
 * A model that answers after `delayMs` (never, for Infinity), and gives up like the openai client does: when the
 * `timeout` it was given passes it rejects with APIConnectionTimeoutError, and when a signal it was given aborts
 * it rejects with an AbortError at once. llm.ts passes a timeout, so the timeout is what ends these calls.
 */
function slowModel(delayMs: number, config: ReturnType<typeof realConfig>) {
  return (params: CreateParams, options: CreateOptions = {}) =>
    new Promise((resolve, reject) => {
      const timers: NodeJS.Timeout[] = [];
      const fail = (error: Error) => {
        timers.forEach(clearTimeout);
        reject(error);
      };
      const timedOut = () => fail(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }));
      if (options.timeout !== undefined) timers.push(setTimeout(timedOut, options.timeout));
      options.signal?.addEventListener("abort", () => fail(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      if (Number.isFinite(delayMs)) {
        timers.push(
          setTimeout(() => {
            timers.forEach(clearTimeout);
            sampleReply(params, config).then(resolve, reject);
          }, delayMs),
        );
      }
    });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let dir: string;
let runNumber = 0;
const nextId = (name: string) => `fail-${name}-${process.pid}-${(runNumber += 1)}`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-failures-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  mocks.create.mockReset();
  mocks.sampleCalls.mockReset();
  resetModelQuirks();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const explainWeek = (id: string, config: ReturnType<typeof realConfig>) =>
  run({ runId: id, task: "explain_week", input: { question: QUESTION, as_of: AS_OF }, config });

const trace = (result: RunResult): TraceLine[] =>
  readFileSync(path.resolve(result.log_file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);

/** Runs `body`, and returns its result with the milliseconds it took. */
async function timed<T>(body: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  const result = await body();
  return { result, ms: Date.now() - started };
}

describe("Zetaris fails: the query falls back to local rows", () => {
  const cases: { name: string; respond: () => Response; why: RegExp }[] = [
    { name: "401 (a wrong ZETARIS_API_KEY)", respond: () => json(401, { message: "invalid token" }), why: /401/ },
    { name: "an error (Postgres stopped behind Zetaris)", respond: () => json(500, { message: "could not connect to server" }), why: /500/ },
  ];

  for (const { name, respond, why } of cases) {
    it(`gives local rows, source local-fallback and trace status fallback on ${name}`, async () => {
      const fetchMock = vi.fn(async () => respond());
      vi.stubGlobal("fetch", fetchMock);
      const config = realConfig();
      mocks.create.mockImplementation((params: CreateParams) => sampleReply(params, config));

      const { result, ms } = await timed(() => explainWeek(nextId("zetaris"), config));

      expect(result.status).toBe("success");
      expect(fetchMock).toHaveBeenCalled();
      const lines = trace(result);
      const queries = lines.filter((line) => line.agent_name === "Query" && line.action === "query");
      const fellBack = queries.filter((line) => line.source === "local-fallback");
      expect(fellBack.length).toBeGreaterThan(0);
      for (const line of fellBack) {
        expect(line.status).toBe("fallback");
        expect(line.why).toMatch(why);
        expect(JSON.stringify(line)).not.toContain("test-key");
      }
      expect(queries.some((line) => line.source === "zetaris")).toBe(false);
      expect(queries.every((line) => line.source === "local" || line.source === "local-fallback")).toBe(true);
      expect(result.output?.citations.some((citation) => citation.source === "local-fallback")).toBe(true);

      // The rows are the ones a plain local run gives.
      vi.stubGlobal("fetch", vi.fn(async () => json(500, {})));
      const local = await run({ runId: nextId("zetaris-local"), task: "explain_week", input: { question: QUESTION, as_of: AS_OF }, sampleMode: true, config: sampleConfig() });
      const expected = local.output!.citations.find((citation) => citation.query_id === "week_moves")!;
      const got = result.output!.citations.find((citation) => citation.query_id === "week_moves" && JSON.stringify(citation.params) === JSON.stringify(expected.params))!;
      expect(got.source).toBe("local-fallback");
      expect(got.rows.length).toBeGreaterThan(0);
      expect(got.rows).toEqual(expected.rows);
      console.log(`[failures] zetaris ${name}: status=${result.status} source=${got.source} ${ms} ms`);
    }, 30000);
  }
});

describe("no Meterless key: sample mode", () => {
  it("runs the sample model, returns success and cites this run's rows", async () => {
    const config = sampleConfig();
    expect(config.sampleMode).toBe(true);
    expect(config.METERLESS_API_KEY).toBeUndefined();

    const result = await explainWeek(nextId("nokey"), config);

    expect(result.status).toBe("success");
    expect(result.error).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.agents.every((agent) => agent.model === "sample-model")).toBe(true);
    const output = result.output!;
    expect(output.model_source).toBe("sample-model");
    expect(output.findings.length).toBeGreaterThan(0);
    const citations = new Map(output.citations.map((citation) => [citation.run_query_id, citation]));
    for (const finding of output.findings) {
      expect(finding.cites.length).toBeGreaterThan(0);
      for (const cite of finding.cites) {
        const citation = citations.get(cite);
        expect(citation, `finding cites ${cite}`).toBeDefined();
        expect(citation!.source).toBe("local");
        expect(citation!.row_count).toBeGreaterThan(0);
      }
    }
    // A cited id is one this run's Query lines made: every citation's query ran in this trace.
    const ran = trace(result).filter((line) => line.agent_name === "Query" && line.action === "query").map((line) => line.input_summary.split(" ")[0]);
    for (const citation of output.citations) expect(ran).toContain(citation.query_id);
  }, 30000);
});

describe("the model fails", () => {
  it("retries a reply that is not JSON once, then returns a structured BadJson error", async () => {
    const config = realConfig();
    mocks.create.mockResolvedValue({ model: "test-strong", choices: [{ message: { role: "assistant", content: "not json" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });

    const { result, ms } = await timed(() => explainWeek(nextId("badjson"), config));

    expect(result.status).toBe("error");
    expect(result.output).toBeNull();
    expect(result.error).toEqual({ type: "BadJson", message: expect.any(String), recoverable: false });
    expect(result.error!.message.length).toBeGreaterThan(0);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const lines = trace(result);
    expect(lines.filter((line) => line.action === "model_retry" && line.why === "unparseable JSON reply")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ agent_name: "Orchestrator", action: "run_end", status: "error" });
    console.log(`[failures] bad json twice: status=${result.status} error.type=${result.error!.type} ${ms} ms`);
  }, 30000);

  it("returns NightshiftNotRunning for a refused connection, with no fallback and no sample reply", async () => {
    const config = realConfig();
    expect(config.sampleMode).toBe(false);
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
    mocks.create.mockRejectedValue(refused);

    const { result, ms } = await timed(() => explainWeek(nextId("refused"), config));

    expect(result.status).toBe("error");
    expect(result.output).toBeNull();
    expect(result.error).toMatchObject({ type: "NightshiftNotRunning", recoverable: false });
    expect(result.error!.message).toContain("Nightshift not running");
    // One request: neither a retry nor the strong-to-main fallback, and the sample model never answered.
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.sampleCalls).not.toHaveBeenCalled();
    const lines = trace(result);
    expect(lines.some((line) => line.output_summary.includes("sample model answered"))).toBe(false);
    expect(lines.some((line) => line.fallback === "strong->main")).toBe(false);
    console.log(`[failures] nightshift refused: status=${result.status} error.type=${result.error!.type} ${ms} ms`);
  }, 30000);
});

describe("every run-ending limit ends in needs_human with its stop_reason", () => {
  it("returns run_timeout within 3 s when the model never answers and RUN_TIMEOUT_MS is 2000", async () => {
    const config = realConfig({ RUN_TIMEOUT_MS: "2000" });
    mocks.create.mockImplementation(slowModel(Infinity, config));

    const { result, ms } = await timed(() => explainWeek(nextId("run-timeout"), config));

    expect(ms).toBeLessThan(3000);
    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ needs_human: true, partial: true, stop_reason: "run_timeout" });
    const lines = trace(result);
    expect(lines.at(-1)).toMatchObject({ action: "run_end", status: "needs_human", stop_reason: "run_timeout" });
    // The retry and the strong-to-main fallback respected the time left: no model call outlived the run.
    expect(mocks.create.mock.calls.length).toBeLessThanOrEqual(2);
    console.log(`[failures] run_timeout: status=${result.status} stop_reason=${result.output?.stop_reason} ${ms} ms`);
  }, 15000);

  it("returns round_timeout within 2 s when a model call takes 400 ms and ROUND_TIMEOUT_MS is 300", async () => {
    const config = realConfig({ ROUND_TIMEOUT_MS: "300" });
    mocks.create.mockImplementation(slowModel(400, config));

    const { result, ms } = await timed(() => explainWeek(nextId("round-timeout"), config));

    expect(ms).toBeLessThan(2000);
    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ needs_human: true, partial: true, stop_reason: "round_timeout" });
    expect(trace(result).at(-1)).toMatchObject({ action: "run_end", status: "needs_human", stop_reason: "round_timeout" });
    console.log(`[failures] round_timeout: status=${result.status} stop_reason=${result.output?.stop_reason} ${ms} ms`);
  }, 15000);

  it("returns query_calls with a partial draft when MAX_QUERY_CALLS is 2", async () => {
    const { result, ms } = await timed(() => explainWeek(nextId("query-calls"), sampleConfig({ MAX_QUERY_CALLS: "2" })));

    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ needs_human: true, partial: true, stop_reason: "query_calls" });
    expect(result.usage.query_calls).toBeLessThanOrEqual(2);
    expect(trace(result).at(-1)).toMatchObject({ action: "run_end", status: "needs_human", stop_reason: "query_calls" });
    console.log(`[failures] query_calls: status=${result.status} stop_reason=${result.output?.stop_reason} ${ms} ms`);
  }, 30000);

  // The same budget stop in the other two paths: the plan or the evidence needs more queries than the budget allows.
  // After the stop no query runs (the Query lines never pass MAX_QUERY_CALLS) and no Evaluator or Writer call is made.
  const stoppedOnQueries = (result: RunResult, max: number) => {
    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ needs_human: true, partial: true, stop_reason: "query_calls" });
    expect(result.output?.summary).toMatch(/query budget/);
    expect(result.usage.query_calls).toBe(max);
    const lines = trace(result);
    expect(lines.filter((line) => line.agent_name === "Query" && line.action === "query" && line.status !== "error")).toHaveLength(max);
    expect(lines.filter((line) => ["Evaluator", "Writer"].includes(line.agent_name))).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ action: "run_end", status: "needs_human", stop_reason: "query_calls" });
  };

  it("thesis_check returns query_calls when the evidence needs more queries than MAX_QUERY_CALLS 2", async () => {
    const result = await run({ runId: nextId("thesis-query-calls"), task: "thesis_check", input: { question: QUESTION, as_of: AS_OF }, config: sampleConfig({ MAX_QUERY_CALLS: "2" }) });
    stoppedOnQueries(result, 2);
  }, 30000);

  it("pre_trade returns query_calls when the fixed plan needs more queries than MAX_QUERY_CALLS 2", async () => {
    const result = await run({ runId: nextId("pretrade-query-calls"), task: "pre_trade", input: { plan_id: "p-03", as_of: AS_OF }, config: sampleConfig({ MAX_QUERY_CALLS: "2" }) });
    stoppedOnQueries(result, 2);
  }, 30000);

  it("returns model_calls when MAX_MODEL_CALLS is 2", async () => {
    const { result, ms } = await timed(() => explainWeek(nextId("model-calls"), sampleConfig({ MAX_MODEL_CALLS: "2" })));

    expect(result.status).toBe("needs_human");
    expect(result.output).toMatchObject({ needs_human: true, stop_reason: "model_calls" });
    expect(result.usage.model_calls).toBeLessThanOrEqual(2);
    expect(trace(result).at(-1)).toMatchObject({ action: "run_end", status: "needs_human", stop_reason: "model_calls" });
    console.log(`[failures] model_calls: status=${result.status} stop_reason=${result.output?.stop_reason} ${ms} ms`);
  }, 30000);
});
