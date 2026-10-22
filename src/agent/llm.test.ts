import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import {
  BadJson,
  complete,
  ModelHttpError,
  ModelTimeout,
  NightshiftNotRunning,
  parseJsonReply,
  PromptTooLarge,
  resetModelQuirks,
  Unauthorized,
  type CompleteOptions,
} from "./llm";
import { complete as sampleComplete } from "./sample-model";
import type { TraceInput } from "./trace";

const mocks = vi.hoisted(() => ({ create: vi.fn(), ctor: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
    constructor(options: unknown) {
      mocks.ctor(options);
    }
  },
}));
vi.mock("./sample-model", () => ({ complete: vi.fn() }));

// Made-up values only: no real endpoint, model id or key appears here.
const KEY = "test-key-0123456789";
const config = loadConfig(
  {
    METERLESS_API_KEY: KEY,
    METERLESS_BASE_URL: "https://nightshift.example.test/v1",
    NEMOTRON_MODEL_STRONG: "lane/strong",
    NEMOTRON_MODEL_MAIN: "lane/main",
    NEMOTRON_MODEL_FAST: "lane/fast",
  },
  () => {},
);

let lines: TraceInput[] = [];
const tracer = {
  log: (input: TraceInput) => {
    lines.push(input);
    return input as never;
  },
};

const base: CompleteOptions = { system: "You are a planner.", user: "Plan the week.", model: "main", agent: "Planner", sampleMode: false, config, tracer };

const reply = (content: string | null, extra: Record<string, unknown> = {}) => ({
  model: "reported/model",
  choices: [{ message: { role: "assistant", content, ...extra } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const httpError = (status: number, message: string) => Object.assign(new Error(message), { name: "APIError", status });
const traced = (action: string) => lines.filter((line) => line.action === action);

beforeEach(() => {
  mocks.create.mockReset();
  mocks.ctor.mockReset();
  vi.mocked(sampleComplete).mockReset();
  resetModelQuirks();
  lines = [];
});

describe("parseJsonReply", () => {
  it("strips a think block and a Markdown fence", () => {
    const text = '<think>some reasoning</think>\n```json\n{"a": 1}\n```';
    expect(parseJsonReply(text)).toEqual({ a: 1 });
  });

  it("takes the text from the first { to the last }", () => {
    expect(parseJsonReply('Here is the plan: {"a": 1}')).toEqual({ a: 1 });
  });

  it("throws BadJson when there is no JSON", () => {
    expect(() => parseJsonReply("no json here")).toThrow(BadJson);
  });
});

describe("complete with the openai client mocked", () => {
  it("refuses a prompt over MAX_PROMPT_CHARS and never calls the client", async () => {
    const user = "x".repeat(config.MAX_PROMPT_CHARS + 1 - base.system.length);
    await expect(complete({ ...base, user })).rejects.toThrow(PromptTooLarge);
    expect(mocks.create).toHaveBeenCalledTimes(0);
  });

  it("counts the history (tool results) toward MAX_PROMPT_CHARS", async () => {
    const history = [{ role: "tool" as const, tool_call_id: "c1", content: "y".repeat(config.MAX_PROMPT_CHARS) }];
    await expect(complete({ ...base, history })).rejects.toThrow(/system, user and history/);
    expect(mocks.create).toHaveBeenCalledTimes(0);
  });

  it("falls back from strong to main with the same messages when strong answers 404", async () => {
    mocks.create.mockRejectedValueOnce(httpError(404, "model not found")).mockResolvedValueOnce(reply("fine"));
    const result = await complete({ ...base, model: "strong" });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const [strongRequest] = mocks.create.mock.calls[0] as [{ model: string; messages: unknown }];
    const [mainRequest] = mocks.create.mock.calls[1] as [{ model: string; messages: unknown }];
    expect(strongRequest.model).toBe("lane/strong");
    expect(mainRequest.model).toBe("lane/main");
    expect(mainRequest.messages).toEqual(strongRequest.messages);
    expect(result.fallback).toBe("strong->main");
    expect(lines.some((line) => line.status === "fallback" && line.why === "strong model unavailable")).toBe(true);
  });

  it("asks once more for unparseable JSON, then returns the parsed reply", async () => {
    mocks.create.mockResolvedValueOnce(reply("not json")).mockResolvedValueOnce(reply('{"a": 1}'));
    const result = await complete({ ...base, json: true });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const [second] = mocks.create.mock.calls[1] as [{ messages: { role: string; content: string }[] }];
    expect(second.messages.find((m) => m.role === "user")?.content).toContain("Reply with the JSON object only.");
    expect(result.json).toEqual({ a: 1 });
    const line = traced("model_call")[0];
    expect(line.model_retries).toBe(1);
    expect(line.retry_count ?? 0).toBe(0);
  });

  it("throws BadJson when the second reply is not JSON either", async () => {
    mocks.create.mockResolvedValue(reply("still not json"));
    await expect(complete({ ...base, json: true })).rejects.toThrow(BadJson);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("resends without response_format after a 400 that names it, and traces it once per model id", async () => {
    mocks.create.mockRejectedValueOnce(httpError(400, "Unsupported parameter: response_format")).mockResolvedValue(reply('{"a": 1}'));
    await complete({ ...base, json: true });
    const [first] = mocks.create.mock.calls[0] as [Record<string, unknown>];
    const [second] = mocks.create.mock.calls[1] as [Record<string, unknown>];
    expect(first.response_format).toEqual({ type: "json_object" });
    expect(second).not.toHaveProperty("response_format");
    expect(traced("json_mode_unsupported")).toHaveLength(1);

    // The same model id remembers it: no response_format, no second trace line. Another model id still sends it.
    await complete({ ...base, json: true });
    expect(mocks.create.mock.calls[2][0]).not.toHaveProperty("response_format");
    await complete({ ...base, json: true, model: "fast" });
    expect(mocks.create.mock.calls[3][0]).toHaveProperty("response_format");
    expect(traced("json_mode_unsupported")).toHaveLength(1);
  });

  it("returns tool calls with parsed arguments, and marks arguments that do not parse", async () => {
    const call = (id: string, args: string) => ({ id, type: "function", function: { name: "week_moves", arguments: args } });
    mocks.create.mockResolvedValueOnce(reply(null, { tool_calls: [call("c1", '{"as_of":"2026-10-01"}')] }));
    const good = await complete({ ...base, tools: [{ type: "function", function: { name: "week_moves", parameters: {} } }] });
    expect(good.tool_calls).toEqual([{ id: "c1", name: "week_moves", arguments: { as_of: "2026-10-01" } }]);
    expect(good.text).toBeNull();
    expect(good.json).toBeNull();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ tool_choice: "auto" });

    mocks.create.mockResolvedValueOnce(reply(null, { tool_calls: [call("c2", "{bad")] }));
    const bad = await complete(base);
    expect(bad.tool_calls?.[0]).toMatchObject({ id: "c2", name: "week_moves", error: "bad_arguments" });
  });

  it("sends TEMPERATURE and MAX_COMPLETION_TOKENS from config.ts", async () => {
    mocks.create.mockResolvedValueOnce(reply("ok"));
    await complete(base);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ temperature: 0.2, max_tokens: 8000 });
    expect(config.TEMPERATURE).toBe(0.2);
    expect(config.MAX_COMPLETION_TOKENS).toBe(8000);
  });

  it("builds the client with the two Meterless headers, no SDK retries and the config's URL", async () => {
    mocks.create.mockResolvedValueOnce(reply("ok"));
    await complete(base);
    expect(mocks.ctor).toHaveBeenCalledTimes(1);
    expect(mocks.ctor.mock.calls[0][0]).toMatchObject({
      baseURL: "https://nightshift.example.test/v1",
      maxRetries: 0,
      defaultHeaders: { "meterless-app": "tradeflow", "meterless-scope": "user" },
    });
  });

  it.each([401, 403])("raises Unauthorized on a %i after one request, without the key", async (status) => {
    mocks.create.mockRejectedValue(httpError(status, `rejected ${KEY}`));
    const error = await complete(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Error).message).toContain("unauthorized");
    expect((error as Error).message).not.toContain(KEY);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(sampleComplete).not.toHaveBeenCalled();
    const errorLine = traced("model_call")[0];
    expect(errorLine).toMatchObject({ status: "error" });
    expect(errorLine.why).toBeTruthy();
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it("raises NightshiftNotRunning on a refused connection after one request", async () => {
    const refused = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8088"), { code: "ECONNREFUSED" }),
    });
    mocks.create.mockRejectedValue(refused);
    const error = await complete({ ...base, model: "strong" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NightshiftNotRunning);
    expect((error as Error).message).toContain("Nightshift not running");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(sampleComplete).not.toHaveBeenCalled();
    expect(traced("model_call")[0]).toMatchObject({ status: "error" });
  });

  it("carries the Nightshift receipt into the result and the trace line, and survives its absence", async () => {
    mocks.create.mockResolvedValueOnce({ ...reply("ok"), meterless: { routed_model: "x/y", cost: { actual_usd: 0.000002 } } });
    const withReceipt = await complete(base);
    expect(withReceipt).toMatchObject({ routed_model: "x/y", cost_usd: 0.000002, model_id: "reported/model", source: "nemotron" });
    expect(traced("model_call")[0]).toMatchObject({
      routed_model: "x/y",
      cost_usd: 0.000002,
      reported_model: "reported/model",
      requested_model: "lane/main",
      provider_host: "nightshift.example.test",
      model: "reported/model",
      usage: { tokens_in: 10, tokens_out: 5 },
    });

    lines = [];
    mocks.create.mockResolvedValueOnce(reply("ok"));
    const without = await complete(base);
    expect(without).not.toHaveProperty("routed_model");
    expect(without).not.toHaveProperty("cost_usd");
    const line = traced("model_call")[0];
    expect(line).not.toHaveProperty("routed_model");
    expect(line).not.toHaveProperty("cost_usd");
  });
});

describe("complete: paths beyond the eleven cases", () => {
  it("retries once on a 429 and traces the retry", async () => {
    mocks.create.mockRejectedValueOnce(httpError(429, "slow down")).mockResolvedValueOnce(reply("ok"));
    const result = await complete(base);
    expect(result.text).toBe("ok");
    expect(traced("model_retry")).toHaveLength(1);
    expect(traced("model_call")[0].model_retries).toBe(1);
  });

  it("makes no retry when the time left is under one second: one request, no model_retry line, ModelTimeout", async () => {
    const timeout = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
    mocks.create.mockRejectedValue(timeout);
    const error = await complete({ ...base, timeoutMs: 900 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelTimeout);
    expect((error as Error).message).toContain("no time left for a retry");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(traced("model_retry")).toHaveLength(0);
    expect(traced("model_call")[0]).toMatchObject({ status: "error", model_retries: 0 });
  });

  it("falls back to main when strong fails twice with a 5xx", async () => {
    mocks.create
      .mockRejectedValueOnce(httpError(503, "down"))
      .mockRejectedValueOnce(httpError(503, "down"))
      .mockResolvedValueOnce(reply("ok"));
    const result = await complete({ ...base, model: "strong" });
    expect(result.fallback).toBe("strong->main");
    expect(mocks.create.mock.calls.map(([request]) => (request as { model: string }).model)).toEqual(["lane/strong", "lane/strong", "lane/main"]);
  });

  it("does not fall back when main answers 404", async () => {
    mocks.create.mockRejectedValue(httpError(404, "no such model"));
    const error = await complete(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  const configFor = (url: string, extra: Record<string, string> = {}) =>
    loadConfig(
      {
        METERLESS_API_KEY: KEY,
        METERLESS_BASE_URL: url,
        NEMOTRON_MODEL_STRONG: "lane/strong",
        NEMOTRON_MODEL_MAIN: "lane/main",
        NEMOTRON_MODEL_FAST: "lane/fast",
        ...extra,
      },
      () => {},
    );
  const nightshift = configFor("http://127.0.0.1:8088/v1");

  it("sends no reasoning field and no chat_template_kwargs on the Nightshift host, for any tier", async () => {
    mocks.create.mockResolvedValue(reply('{"ok":true}'));
    for (const model of ["strong", "main", "fast"] as const) {
      await complete({ ...base, model, json: true, config: nightshift });
      await complete({ ...base, model, config });
    }
    expect(mocks.create).toHaveBeenCalledTimes(6);
    for (const [request] of mocks.create.mock.calls as [Record<string, unknown>][]) {
      expect(request).not.toHaveProperty("reasoning");
      expect(request).not.toHaveProperty("chat_template_kwargs");
    }
    expect(traced("model_call")[0]).toMatchObject({ provider_host: "127.0.0.1", status: "ok" });
  });

  it("keeps reasoning { enabled: false } for the fast tier on OpenRouter only, never chat_template_kwargs", async () => {
    const openrouter = configFor("https://openrouter.ai/api/v1");
    mocks.create.mockResolvedValue(reply("ok"));
    await complete({ ...base, model: "fast", config: openrouter });
    await complete({ ...base, model: "main", config: openrouter });
    const [fast] = mocks.create.mock.calls[0] as [Record<string, unknown>];
    const [main] = mocks.create.mock.calls[1] as [Record<string, unknown>];
    expect(fast.reasoning).toEqual({ enabled: false });
    expect(fast).not.toHaveProperty("chat_template_kwargs");
    expect(main).not.toHaveProperty("reasoning");
    expect(main).not.toHaveProperty("chat_template_kwargs");
  });

  it("retries a 502 empty_response once as the same request at max_tokens 8000, traced as empty_response_retry", async () => {
    const small = configFor("http://127.0.0.1:8088/v1", { MAX_COMPLETION_TOKENS: "4000" });
    mocks.create
      .mockRejectedValueOnce(httpError(502, '502 {"error":{"type":"empty_response","message":"no content"}}'))
      .mockResolvedValueOnce(reply('{"ok":true}'));
    const result = await complete({ ...base, model: "fast", json: true, agent: "Evaluator", config: small });
    expect(result.json).toEqual({ ok: true });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const [first] = mocks.create.mock.calls[0] as [Record<string, unknown>];
    const [second] = mocks.create.mock.calls[1] as [Record<string, unknown>];
    expect(first.max_tokens).toBe(4000);
    expect(second.max_tokens).toBe(8000);
    for (const request of [first, second]) {
      expect(request).not.toHaveProperty("reasoning");
      expect(request).not.toHaveProperty("chat_template_kwargs");
    }
    // Apart from max_tokens, the retry is the same request.
    expect({ ...second, max_tokens: 0 }).toEqual({ ...first, max_tokens: 0 });
    const retries = traced("empty_response_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ agent_name: "Evaluator", status: "retry", model: "lane/fast", why: "the model returned no content (HTTP 502 empty_response)" });
    expect(traced("reasoning_off_retry")).toHaveLength(0);
    expect(traced("model_retry")).toHaveLength(0);
    expect(traced("model_call")[0]).toMatchObject({ status: "ok", model_retries: 1 });
  });

  it("makes no empty_response retry when under one second is left", async () => {
    mocks.create.mockRejectedValue(httpError(502, "502 empty_response"));
    const error = await complete({ ...base, timeoutMs: 900 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(502);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(traced("empty_response_retry")).toHaveLength(0);
  });

  it("throws a ModelHttpError(502) after the one empty_response retry when the second 502 comes back: the caller never loops", async () => {
    mocks.create.mockRejectedValue(httpError(502, "502 empty_response"));
    const error = await complete({ ...base, model: "fast", config: nightshift }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(502);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(traced("empty_response_retry")).toHaveLength(1);
  });

  it("calls the sample model, and never the client, when sampleMode is true", async () => {
    vi.mocked(sampleComplete).mockResolvedValueOnce({ text: "s", usage: null, duration_ms: 1, model_id: "sample", source: "sample-model" });
    const result = await complete({ ...base, sampleMode: true });
    expect(result.source).toBe("sample-model");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.ctor).not.toHaveBeenCalled();
  });

  it("traces one line with the model id, usage and duration_ms for a real sample-model Planner call", async () => {
    const actual = await vi.importActual<typeof import("./sample-model")>("./sample-model");
    vi.mocked(sampleComplete).mockImplementationOnce(actual.complete);
    const user = JSON.stringify({ task: "explain_week", question: "Why?", as_of: "2026-10-01" });
    const result = await complete({ ...base, user, sampleMode: true, json: true, agent: "Planner" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agent_name: "Planner", action: "model_call", status: "ok", model: "sample-model", model_retries: 0 });
    expect(lines[0].usage).toEqual({ tokens_in: result.usage?.tokens_in, tokens_out: result.usage?.tokens_out, model_calls: 1 });
    expect(lines[0].usage?.tokens_in).toBeGreaterThan(0);
    expect(typeof lines[0].duration_ms).toBe("number");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
