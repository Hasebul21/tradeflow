// httpFetch against a stub server on an ephemeral port of 127.0.0.1: no real model and no network.
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpFetch } from "./http-fetch";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
const completion = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "lane/main",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => (body += chunk));
  request.on("end", () => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const encoded = /^\/(gzip|deflate|br)$/.exec(request.url ?? "");
    if (encoded !== null) {
      const raw = Buffer.from(JSON.stringify({ encoded: encoded[1] }));
      const packed = encoded[1] === "gzip" ? zlib.gzipSync(raw) : encoded[1] === "deflate" ? zlib.deflateSync(raw) : zlib.brotliCompressSync(raw);
      response.writeHead(200, { "content-type": "application/json", "content-encoding": encoded[1], "content-length": String(packed.length) });
      response.end(packed);
      return;
    }
    if (request.url === "/status-600") {
      response.writeHead(600, { "content-type": "text/plain" });
      response.end("odd");
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "https://elsewhere.example.test/v1" });
      response.end();
      return;
    }
    if (request.url === "/drip" || request.url === "/cut") {
      // Headers and the first part of the body, then nothing (/drip) or a cut connection (/cut).
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"part": ');
      if (request.url === "/cut") setTimeout(() => response.socket?.destroy(), 100);
      return;
    }
    if (request.url === "/echo") json(200, { method: request.method, body: JSON.parse(body) });
    else if (request.url === "/bad-gateway") json(502, { error: { message: "empty_response" } });
    else if (request.url === "/slow") setTimeout(() => json(200, { slow: true }), 2000);
    else if (request.url === "/never") {
      // No reply: only an abort ends the wait.
    } else if (request.url === "/v1/chat/completions") json(200, completion);
    else if (request.url === "/slow/v1/chat/completions") setTimeout(() => json(200, completion), 2000);
    else json(404, { error: { message: "no route" } });
  });
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const timed = async <T>(work: () => Promise<T>) => {
  const started = Date.now();
  const outcome = await work().then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return { ...outcome, ms: Date.now() - started };
};

describe("httpFetch", () => {
  it("round-trips a JSON request and reply, with the method, headers and status", async () => {
    const response = await httpFetch(`${base}/echo`, {
      method: "post",
      headers: { "content-type": "application/json", "x-test": "1" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ method: "POST", body: { a: 1 } });
    const request = seen.at(-1) as Seen;
    expect(request.headers["x-test"]).toBe("1");
    expect(request.headers["content-length"]).toBe(String(JSON.stringify({ a: 1 }).length));
    expect(request.headers["accept-encoding"]).toBe("identity");
  });

  it("sends a Uint8Array body and takes a URL object", async () => {
    const response = await httpFetch(new URL(`${base}/echo`), { method: "POST", body: new TextEncoder().encode('{"b":2}') });
    expect(await response.json()).toEqual({ method: "POST", body: { b: 2 } });
  });

  it("passes a 502 through with its body", async () => {
    const response = await httpFetch(`${base}/bad-gateway`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual({ error: { message: "empty_response" } });
  });

  it("rejects at once with an AbortError when the signal is already aborted, and sends nothing", async () => {
    const before = seen.length;
    const controller = new AbortController();
    controller.abort();
    const { error, ms } = await timed(() => httpFetch(`${base}/echo`, { method: "POST", body: "{}", signal: controller.signal }));
    expect(error).toMatchObject({ name: "AbortError" });
    expect(ms).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.length).toBe(before);
  });

  it("rejects quickly with an AbortError when aborted while waiting for headers", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { error, ms } = await timed(() => httpFetch(`${base}/never`, { method: "POST", body: "{}", signal: controller.signal }));
    expect(error).toMatchObject({ name: "AbortError" });
    expect(ms).toBeLessThan(1000);
  });

  it("waits for a server that sends its headers after 2 s", async () => {
    const { value, ms } = await timed(() => httpFetch(`${base}/slow`, { method: "POST", body: "{}" }));
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(await (value as Response).json()).toEqual({ slow: true });
  }, 10000);

  it("decodes a gzip, deflate or br reply and drops Content-Encoding and Content-Length", async () => {
    for (const encoding of ["gzip", "deflate", "br"]) {
      const response = await httpFetch(`${base}/${encoding}`, { method: "GET" });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(await response.json()).toEqual({ encoded: encoding });
    }
  });

  it("rejects a status Response refuses (600) with TypeError fetch failed and the RangeError as cause", async () => {
    const { error } = await timed(() => httpFetch(`${base}/status-600`, { method: "GET" }));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("fetch failed");
    expect((error as Error & { cause: unknown }).cause).toBeInstanceOf(RangeError);
  });

  it("refuses a redirect, naming its Location", async () => {
    const { error } = await timed(() => httpFetch(`${base}/redirect`, { method: "POST", body: "{}" }));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error & { cause: Error }).cause.message).toBe("HTTP 307 redirect to https://elsewhere.example.test/v1: httpFetch does not follow redirects");
  });

  it("ends a body that is still streaming with an AbortError when aborted mid-body", async () => {
    const controller = new AbortController();
    const response = await httpFetch(`${base}/drip`, { method: "GET", signal: controller.signal });
    expect(response.status).toBe(200);
    setTimeout(() => controller.abort(), 100);
    const { error, ms } = await timed(() => response.text());
    expect(error).toMatchObject({ name: "AbortError" });
    expect(ms).toBeLessThan(1000);
  });

  it("errors the body when the connection is cut mid-body", async () => {
    const response = await httpFetch(`${base}/cut`, { method: "GET" });
    expect(response.status).toBe(200);
    const { error, ms } = await timed(() => response.text());
    expect(error).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(1000);
  });

  it("rejects a refused connection with TypeError fetch failed and the socket error as cause", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { error } = await timed(() => httpFetch(`http://127.0.0.1:${port}/`, { method: "GET" }));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error & { cause: { code: string } }).cause.code).toBe("ECONNREFUSED");
  });
});

describe("the openai client with httpFetch, built as llm.ts builds it", () => {
  const client = (baseURL: string, timeout?: number) =>
    new OpenAI({
      apiKey: "test-key-0123456789",
      baseURL,
      defaultHeaders: { "meterless-app": "tradeflow", "meterless-scope": "user" },
      maxRetries: 0,
      fetch: httpFetch,
      ...(timeout === undefined ? {} : { timeout }),
    });

  it("gets a chat completion from the stub, with the bearer token and both Meterless headers", async () => {
    const reply = await client(`${base}/v1`).chat.completions.create({ model: "lane/main", messages: [{ role: "user", content: "hi" }] });
    expect(reply.choices[0].message.content).toBe("hello");
    expect(reply.usage?.total_tokens).toBe(4);
    const request = seen.at(-1) as Seen;
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer test-key-0123456789");
    expect(request.headers["meterless-app"]).toBe("tradeflow");
    expect(request.headers["meterless-scope"]).toBe("user");
    expect(JSON.parse(request.body)).toMatchObject({ model: "lane/main", messages: [{ role: "user", content: "hi" }] });
  });

  it("leaves the timeout to the SDK: a 300 ms timeout against a 2 s stub is an APIConnectionTimeoutError in well under 2 s", async () => {
    const { error, ms } = await timed(() =>
      client(`${base}/slow/v1`, 300).chat.completions.create({ model: "lane/main", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error).toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    // llm.ts's classify reads this as a timeout ("timed out" in the message).
    expect((error as Error).message).toMatch(/timed out/i);
    expect(ms).toBeLessThan(1500);
  });

  it("an SDK request aborted by the caller's signal is an APIUserAbortError", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { error, ms } = await timed(() =>
      client(`${base}/slow/v1`).chat.completions.create({ model: "lane/main", messages: [{ role: "user", content: "hi" }] }, { signal: controller.signal }),
    );
    expect(error).toBeInstanceOf(OpenAI.APIUserAbortError);
    expect((error as Error & { cause: unknown }).cause).toMatchObject({ name: "AbortError" });
    expect(ms).toBeLessThan(1000);
  });
});
