// The real openai client with fetch replaced: what goes on the wire, and the error shapes the SDK really throws.
// llm.test.ts mocks the client; this file checks the mock's assumptions against the SDK itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { complete, NightshiftNotRunning, resetModelQuirks, Unauthorized, type CompleteOptions } from "./llm";

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
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "lane/main", temperature: 0.2, max_tokens: 8000 });
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
