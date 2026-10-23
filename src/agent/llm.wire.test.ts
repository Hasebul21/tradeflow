// The real openai client with fetch replaced: what goes on the wire, and the error shapes the SDK really throws.
// llm.test.ts mocks the client; this file checks the mock's assumptions against the SDK itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RESPONSE_MAX_TRIES, loadConfig, MODEL_TIMEOUT_CAP_MS } from "./config";
import { complete, failedCallUsage, ModelHttpError, NightshiftNotRunning, resetModelQuirks, Unauthorized, type CompleteOptions } from "./llm";
import { BudgetExhaustedError } from "./run-state";
import type { TraceInput } from "./trace";

// Made-up values only: no real endpoint, model id or key appears here.
const KEY = "test-key-0123456789";
const config = loadConfig(
  {
    METERLESS_API_KEY: KEY,
    METERLESS_BASE_URL: "https://nightshift.example.test",
    NEMOTRON_MODEL_STRONG: "lane/strong",
    NEMOTRON_MODEL_MAIN: "lane/main",
    NEMOTRON_MODEL_FAST: "lane/fast",
  },
  () => {},
);
const base: CompleteOptions = { system: "s", user: "u", model: "main", agent: "Planner", sampleMode: false, config };
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = { id: "1", object: "chat.completion", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  resetModelQuirks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("complete with the real openai client", () => {
  it("sends the URL from config, the bearer token, both Meterless headers, temperature and max_tokens", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ok));
    const result = await complete(base);
    expect(result.text).toBe("hi");
    expect(result.usage).toEqual({ tokens_in: 3, tokens_out: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string | URL | Request, RequestInit];
    expect(String(url)).toBe("https://nightshift.example.test/v1/chat/completions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("meterless-app")).toBe("tradeflow");
    expect(headers.get("meterless-scope")).toBe("user");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "lane/main", temperature: 0.2, max_tokens: 16000 });
  });

  it("maps a real 401 to Unauthorized after one request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: "bad token" } }));
    const error = await complete(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unauthorized);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a real 400 that names response_format to a resend without it", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "Unknown field: response_format" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ...ok, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"a":1}' } }] }));
    const result = await complete({ ...base, json: true });
    expect(result.json).toEqual({ a: 1 });
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [unknown, RequestInit])[1].body))).not.toHaveProperty("response_format");
  });

  it("maps fetch's refused connection, as the SDK wraps it, to NightshiftNotRunning after one request", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8088"), { code: "ECONNREFUSED" }),
    });
    fetchMock.mockRejectedValue(refused);
    const error = await complete(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NightshiftNotRunning);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("502 empty_response retries within the round (fake timers)", () => {
  const empty = () => jsonResponse(502, { error: { type: "empty_response", message: "no content" } });
  let lines: TraceInput[] = [];
  const tracer = { log: (input: TraceInput) => (lines.push(input), input as never) };
  const retries = () => lines.filter((line) => line.action === "empty_response_retry");
  // A fresh round: ROUND_TIMEOUT_MS (360 s) left, so both waits (15 s, 30 s) leave over MODEL_TIMEOUT_CAP_MS (240 s).
  const inRound = (leftMs: number): CompleteOptions => ({
    ...base,
    tracer,
    timeoutMs: Math.min(MODEL_TIMEOUT_CAP_MS, leftMs),
    roundDeadlineMs: Date.now() + leftMs,
  });

  beforeEach(() => {
    lines = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("2 empty replies, then a good one: success after waits of 15 s and 30 s, 2 empty_response_retry lines", async () => {
    fetchMock.mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty()).mockResolvedValueOnce(jsonResponse(200, ok));
    const pending = complete(inRound(300000));
    await vi.advanceTimersByTimeAsync(14999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.text).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries()).toHaveLength(2);
    expect(retries()[0]!.output_summary).toContain(`try 2 of ${EMPTY_RESPONSE_MAX_TRIES}`);
    expect(retries()[1]!.output_summary).toContain(`try 3 of ${EMPTY_RESPONSE_MAX_TRIES}`);
    expect(lines.find((line) => line.action === "model_call")).toMatchObject({ status: "ok", model_retries: 2 });
  });

  it("1 empty reply, then a good one: model_calls 2 on the result and on the trace lines", async () => {
    fetchMock.mockResolvedValueOnce(empty()).mockResolvedValueOnce(jsonResponse(200, ok));
    const pending = complete(inRound(300000));
    await vi.advanceTimersByTimeAsync(15000);
    const result = await pending;
    expect(result.text).toBe("hi");
    expect(result.model_calls).toBe(2);
    expect(retries()).toHaveLength(1);
    expect(retries()[0]).toMatchObject({ usage: { model_calls: 1 } });
    expect(retries()[0]!.output_summary).toContain("counted as a model call");
    expect(lines.reduce((n, line) => n + (line.usage?.model_calls ?? 0), 0)).toBe(2);
  });

  it("sends no retry past modelCallsLeft: BudgetExhaustedError, with the failed request counted", async () => {
    fetchMock.mockImplementation(async () => empty());
    const error = await complete({ ...inRound(300000), modelCallsLeft: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).stop_reason).toBe("max_model_calls");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failedCallUsage(error).model_calls).toBe(1);
    expect(lines.reduce((n, line) => n + (line.usage?.model_calls ?? 0), 0)).toBe(1);
  });

  it("3 empty replies: a ModelHttpError(502) naming 3 failed tries, and no fourth request", async () => {
    fetchMock.mockImplementation(async () => empty());
    const pending = complete(inRound(300000)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45000);
    const error = await pending;
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(502);
    expect((error as Error).message).toContain("3 tries failed with HTTP 502 empty_response");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries()).toHaveLength(2);
    expect(failedCallUsage(error).model_calls).toBe(3);
    expect(lines.reduce((n, line) => n + (line.usage?.model_calls ?? 0), 0)).toBe(3);
  });

  it("1 empty reply with 300000 ms left in the round: the retry starts after the 15 s wait", async () => {
    fetchMock.mockResolvedValueOnce(empty()).mockResolvedValueOnce(jsonResponse(200, ok));
    const pending = complete(inRound(300000));
    await vi.advanceTimersByTimeAsync(15000);
    expect((await pending).text).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries()).toHaveLength(1);
  });

  it("1 empty reply with 200000 ms left in the round: a ModelHttpError(502) and no retry", async () => {
    fetchMock.mockImplementation(async () => empty());
    const error = await complete(inRound(200000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retries()).toHaveLength(0);
  });

  it("1 empty reply with under MODEL_TIMEOUT_CAP_MS left in the round: a ModelHttpError(502) and no retry", async () => {
    fetchMock.mockImplementation(async () => empty());
    const error = await complete(inRound(MODEL_TIMEOUT_CAP_MS - 1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(502);
    expect((error as Error).message).toContain("1 try failed with HTTP 502 empty_response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retries()).toHaveLength(0);
  });
});
