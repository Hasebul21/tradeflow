import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { active, register, release } from "@/agent/registry";
import { busyReply } from "@/agent/request";
import { POST } from "./route";

const logs = () => (existsSync(path.resolve("logs")) ? readdirSync(path.resolve("logs")).sort() : []);

beforeEach(() => {
  vi.stubEnv("MAX_CONCURRENT_RUNS", "1");
  vi.stubEnv("SAMPLE_MODE", "true");
  vi.stubEnv("LOG_LEVEL", "error");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { run_id } of active()) release(run_id);
});

const post = (body: unknown) => POST(new NextRequest("http://localhost/run", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const valid = { run_id: "busy-new", input: { question: "Why did my portfolio move this week?", as_of: "2026-10-01" } };

describe("POST /run with the server full", () => {
  it("answers 429 Busy with Retry-After, zero usage and no new trace file", async () => {
    register({ run_id: "busy-held", task: "explain_week" });
    const before = logs();
    const res = await post(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.error).toEqual({ type: "Busy", message: "The server is running 1 runs; try again in a few seconds.", recoverable: true });
    expect(body.usage).toEqual({ model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 });
    expect(logs()).toEqual(before);
    expect(logs()).not.toContain("trace-busy-new.jsonl");
  });

  it("counts top-level runs only: a briefing's child leaves room", () => {
    register({ run_id: "busy-parent-1-explain_week", task: "explain_week", parent_run_id: "busy-parent" });
    expect(busyReply()).toBeNull();
    register({ run_id: "busy-parent", task: "briefing" });
    expect(busyReply()?.error.type).toBe("Busy");
  });

  it("reads the cap from MAX_CONCURRENT_RUNS", () => {
    register({ run_id: "busy-a", task: "explain_week" });
    expect(busyReply(1, { MAX_CONCURRENT_RUNS: "2" })).toBeNull();
    expect(busyReply(2, { MAX_CONCURRENT_RUNS: "2" })?.error.type).toBe("Busy");
    // The default cap is 2.
    expect(busyReply(1, {})).toBeNull();
    expect(busyReply(2, {})?.error.type).toBe("Busy");
  });
});
