import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retryAfterMs, runHttpCase, summaryLine } from "./live-runner";

let server: http.Server | null = null;
let tmp: string | null = null;
afterEach(async () => {
  if (server !== null) await new Promise((resolve) => server?.close(resolve));
  if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  server = null;
  tmp = null;
});

/** A stub app: POST /run answers each reply in `replies` in turn; GET /run/<id> answers two trace lines. */
async function stubServer(replies: { status: number; headers?: Record<string, string>; body: unknown }[]): Promise<{ base: string; posts: () => number }> {
  let posts = 0;
  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/run") {
      req.resume();
      req.on("end", () => {
        const reply = replies[Math.min(posts, replies.length - 1)];
        posts += 1;
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/run/example_1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run_id: "example_1", done: true, lines: [{ action: "run_start" }, { action: "run_end" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts: () => posts };
}

const busy = { status: 429, headers: { "Retry-After": "2" }, body: { status: "error", error: { type: "Busy", message: "The server is running 2 runs; try again in a few seconds.", recoverable: true } } };
const success = { status: 200, body: { run_id: "example_1", status: "success", output: { stop_reason: null }, usage: { model_calls: 4 } } };

describe("runHttpCase", () => {
  it("retries a 429 Busy after Retry-After, then saves the reply and the trace", { timeout: 15_000 }, async () => {
    const { base, posts } = await stubServer([busy, success]);
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    const waits: number[] = [];
    const outcome = await runHttpCase({ id: "example_1", body: { run_id: "example_1", input: {} } }, base, tmp, 10_000, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([2000]);
    expect(posts()).toBe(2);
    expect(outcome.http).toBe(200);
    expect(outcome.busyRetries).toBe(1);
    expect(JSON.parse(readFileSync(path.join(tmp, "example_1.json"), "utf8"))).toEqual(success.body);
    expect(readFileSync(path.join(tmp, "example_1.trace.jsonl"), "utf8")).toBe('{"action":"run_start"}\n{"action":"run_end"}\n');
    expect(summaryLine(outcome)).toMatch(/^example_1 {2}200 {2}success {2}- {2}\d+\.\d s {2}4 model calls {2}\(1 busy retries\)$/);
  });

  it("does not retry a 429 that is not Busy, and stops retrying Busy once the wait would pass the timeout", { timeout: 15_000 }, async () => {
    const other = { status: 429, body: { status: "error", error: { type: "RateLimited", message: "x", recoverable: true } } };
    const first = await stubServer([other, success]);
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    const outcome = await runHttpCase({ id: "example_1", body: { run_id: "example_1" } }, first.base, tmp, 10_000, { sleep: async () => {} });
    expect(first.posts()).toBe(1);
    expect(outcome.http).toBe(429);

    await new Promise((resolve) => server?.close(resolve));
    const second = await stubServer([busy]);
    const waits: number[] = [];
    const stuck = await runHttpCase({ id: "example_1", body: { run_id: "example_1" } }, second.base, tmp, 5_000, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([2000, 2000]);
    expect(stuck.http).toBe(429);
    expect(stuck.note).toBe("still busy after waiting the full timeout");
  });
});

describe("retryAfterMs", () => {
  it("reads whole seconds and falls back to 5 s", () => {
    expect(retryAfterMs({ "retry-after": "3" })).toBe(3000);
    expect(retryAfterMs({})).toBe(5000);
    expect(retryAfterMs({ "retry-after": "soon" })).toBe(5000);
  });
});
