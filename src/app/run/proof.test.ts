import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./[run_id]/proof/route";
import { POST } from "./route";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-proof-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  vi.stubEnv("TRADEFLOW_DATA_DIR", dir);
  vi.stubEnv("SAMPLE_MODE", "true");
  vi.stubEnv("LOG_LEVEL", "error");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const proof = (runId: string) => GET(new NextRequest(`http://localhost/run/${runId}/proof`), { params: Promise.resolve({ run_id: runId }) });

describe("GET /run/<run_id>/proof", () => {
  it("200 with the counts of a run just made", async () => {
    const runId = `proof-route-${Date.now()}`;
    const res = await POST(new NextRequest("http://localhost/run", { method: "POST", body: JSON.stringify({ run_id: runId, input: { question: "Why did my portfolio move this week?", as_of: "2026-10-01" } }), headers: { "content-type": "application/json" } }));
    expect((await res.json()).status).toBe("success");
    const trace = (await readFile(path.resolve("logs", `trace-${runId}.jsonl`), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const queries = trace.filter((l) => l.agent_name === "Query" && l.action !== "cached").length;
    const out = await proof(runId);
    expect(out.status).toBe(200);
    const body = await out.json();
    expect(body.zetaris.queries).toBe(queries);
    expect(queries).toBeGreaterThan(0);
    expect(body.zetaris.local).toBe(queries);
    expect(body.loop.rounds).toBeGreaterThan(0);
    await rm(path.resolve("logs", `trace-${runId}.jsonl`), { force: true });
  }, 60_000);

  it("400 on a bad id", async () => {
    expect((await proof("bad id!")).status).toBe(400);
  });

  it("404 on an unknown id", async () => {
    expect((await proof("no-such-run-xyz")).status).toBe(404);
  });
});
