import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./[run_id]/route";
import { POST } from "./route";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-route-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  vi.stubEnv("TRADEFLOW_DATA_DIR", dir);
  vi.stubEnv("SAMPLE_MODE", "");
  vi.stubEnv("METERLESS_API_KEY", "");
  vi.stubEnv("LOG_LEVEL", "error");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const post = (body: string) => POST(new NextRequest("http://localhost/run", { method: "POST", body, headers: { "content-type": "application/json" } }));
const get = (runId: string) => GET(new NextRequest(`http://localhost/run/${runId}`), { params: Promise.resolve({ run_id: runId }) });

describe("POST /run and GET /run/<run_id>", () => {
  it("runs a request and then serves its trace lines in order, done true", async () => {
    const res = await post(JSON.stringify({ run_id: "route-week", input: { question: "Why did my portfolio move this week?", as_of: "2026-10-01" }, options: { sample_mode: true } }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("success");

    const trace = await get("route-week");
    expect(trace.status).toBe(200);
    const body = await trace.json();
    expect(body.run_id).toBe("route-week");
    expect(body.done).toBe(true);
    const names: string[] = body.lines.map((line: { agent_name: string }) => line.agent_name);
    const first = ["Planner", "Analyst", "Evaluator", "Writer"].map((name) => names.indexOf(name));
    expect(first.every((index) => index >= 0)).toBe(true);
    expect([...first].sort((a, b) => a - b)).toEqual(first);
    expect(body.lines.at(-1)).toMatchObject({ agent_name: "Orchestrator", action: "run_end" });
  });

  it("answers 400 for a bad body, an empty question and a bad run id, 404 for an unknown run", async () => {
    expect((await post("{not json")).status).toBe(400);
    const empty = await post(JSON.stringify({ input: { question: "" }, options: { sample_mode: true } }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.type).toBe("InvalidInput");
    expect((await get("../etc")).status).toBe(400);
    expect((await get("a b")).status).toBe(400);
    const missing = await get("no-such-run");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.type).toBe("NotFound");
  });
});
