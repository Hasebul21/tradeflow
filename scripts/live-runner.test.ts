import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Settled } from "../src/agent/concurrency";
import { caseKind, liveCases, liveExitCode, memorySeen, retryAfterMs, runCliCase, runHttpCase, runLiveGroup, summaryLine, type LiveCase, type LiveOutcome, type SpawnAgent } from "./live-runner";

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
      res.end(JSON.stringify({ run_id: "example_1", done: true, lines: [{ action: "run_start" }, { agent_name: "Memory", action: "recall", output_summary: "by_tag=mem-52; by_query=none; corrections=none" }, { action: "run_end" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts: () => posts };
}

const busy = { status: 429, headers: { "Retry-After": "2" }, body: { status: "error", error: { type: "Busy", message: "The server is running 2 runs; try again in a few seconds.", recoverable: true } } };
const success = {
  status: 200,
  body: { run_id: "example_1", status: "success", output: { stop_reason: null, memories_recalled: [{ id: "mem-52", tags: ["review", "explain_week", "2026-09-24", "run:example_3a"] }] }, usage: { model_calls: 4 } },
};

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
    expect(readFileSync(path.join(tmp, "example_1.trace.jsonl"), "utf8").split("\n")).toHaveLength(4);
    expect(outcome.memory).toBe("by_tag=mem-52 (review of example_3a); by_query=none");
    expect(summaryLine(outcome)).toMatch(/^example_1 {2}200 {2}success {2}- {2}\d+\.\d s {2}4 model calls {2}memory: by_tag=mem-52 \(review of example_3a\); by_query=none {2}\(1 busy retries\)$/);
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
    expect(stuck.reply).toBeNull();
    expect(stuck.note).toBe("no result: still 429 Busy after waiting the full timeout");
  });
});

describe("runHttpCase and stale traces", () => {
  it("removes an old saved trace before the POST and reads no memory when this run's trace was not saved", { timeout: 15_000 }, async () => {
    const reply = { status: 200, body: { run_id: "example_2", status: "success", output: { stop_reason: null }, usage: { model_calls: 4 } } };
    const { base } = await stubServer([reply]);
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    writeFileSync(path.join(tmp, "example_2.trace.jsonl"), `${JSON.stringify({ agent_name: "Memory", action: "recall", output_summary: "by_tag=mem-1; by_query=none" })}\n`);
    const outcome = await runHttpCase({ id: "example_2", body: { run_id: "example_2" } }, base, tmp, 10_000);
    expect(outcome.note).toBe("trace not saved: GET /run/example_2 answered 404");
    expect(outcome.memory).toBeNull();
    expect(existsSync(path.join(tmp, "example_2.trace.jsonl"))).toBe(false);
  });

  it("names the type of a 429 that is not Busy and keeps its reply", { timeout: 15_000 }, async () => {
    const { base } = await stubServer([{ status: 429, body: { status: "error", error: { type: "RateLimited", message: "x", recoverable: true } } }]);
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    const outcome = await runHttpCase({ id: "example_2", body: { run_id: "example_2" } }, base, tmp, 10_000);
    expect(outcome.reply).not.toBeNull();
    expect(outcome.note).toMatch(/^429 RateLimited/);
  });
});

describe("caseKind and liveExitCode", () => {
  const example1: LiveCase = { id: "example_1", body: {}, expect: { status: "success" } };
  const errorCase: LiveCase = { id: "before-the-data", body: {}, expect: { status: "error", error_type: "InvalidInput" } };
  const reply = (status: string, type?: string) => ({ run_id: "r", status, ...(type === undefined ? {} : { error: { type, message: "m", recoverable: false } }) });
  const outcome = (id: string, body: Record<string, unknown> | null, http: number | null = 200): LiveOutcome => ({ id, http, reply: body, seconds: 0, busyRetries: 0, note: null });
  const fulfilled: Settled<void> = { status: "fulfilled", value: undefined };
  const tally = (cases: LiveCase[], outcomes: LiveOutcome[], settled: Settled<void>[] = cases.map(() => fulfilled)) =>
    liveExitCode(cases, new Map(outcomes.map((item) => [item.id, item])), cases.map((item) => [item.id]), settled);

  it("reads what each case expects from the repo's expectations", () => {
    expect(liveCases(process.cwd(), true).find((item) => item.id === "before-the-data")?.expect).toEqual({ status: "error", error_type: "InvalidInput" });
    expect(liveCases(process.cwd(), false).find((item) => item.id === "example_1")?.expect).toEqual({ status: "success" });
  });

  it("gives exit 1 for a 500 Timeout on example_1, and counts an expected InvalidInput as a result", () => {
    const timeout = outcome("example_1", reply("error", "Timeout"), 500);
    expect(caseKind(example1, timeout)).toBe("unexpected error");
    expect(tally([example1], [timeout])).toMatchObject({ code: 1, byKind: { "unexpected error": ["example_1"] } });
    const invalid = outcome("before-the-data", reply("error", "InvalidInput"), 400);
    expect(caseKind(errorCase, invalid)).toBe("expected error");
    expect(tally([errorCase], [invalid])).toMatchObject({ code: 0, byKind: { "expected error": ["before-the-data"] } });
    expect(summaryLine(timeout, "unexpected error")).toContain("[unexpected error]");
  });

  it("gives exit 1 for an error of another type than the one expected, and for RateLimited", () => {
    expect(tally([errorCase], [outcome("before-the-data", reply("error", "Internal"), 500)]).code).toBe(1);
    expect(tally([example1], [outcome("example_1", reply("error", "RateLimited"), 500)]).code).toBe(1);
  });

  it("gives exit 1 for no reply, still Busy and a case not run, and 0 for results alone", () => {
    expect(tally([example1], [outcome("example_1", null, null)]).code).toBe(1);
    expect(tally([example1], [{ ...outcome("example_1", null, 429), note: "no result: still 429 Busy after waiting the full timeout" }]).byKind["no result"]).toEqual(["example_1"]);
    expect(tally([example1], [outcome("example_1", reply("needs_human"))]).code).toBe(0);
    expect(tally([example1], [outcome("example_1", reply("success"))]).code).toBe(0);
  });

  it("gives exit 1 for a missing id and for a rejected group, though every reply is a result", () => {
    const second: LiveCase = { id: "example_2", body: {}, expect: { status: "success" } };
    const missing = tally([example1, second], [outcome("example_1", reply("success"))]);
    expect(missing).toMatchObject({ code: 1, missing: ["example_2"] });
    const rejected = tally([example1], [outcome("example_1", reply("success"))], [{ status: "rejected", reason: new Error("boom") }]);
    expect(rejected).toMatchObject({ code: 1, rejected: [{ ids: ["example_1"], reason: "boom" }] });
  });
});

describe("retryAfterMs", () => {
  it("reads whole seconds, falls back to 5 s and never waits less than 1 s", () => {
    expect(retryAfterMs({ "retry-after": "3" })).toBe(3000);
    expect(retryAfterMs({})).toBe(5000);
    expect(retryAfterMs({ "retry-after": "soon" })).toBe(5000);
    expect(retryAfterMs({ "retry-after": "0" })).toBe(1000);
  });
});

describe("runLiveGroup", () => {
  const result = (id: string, reply: Record<string, unknown> | null): LiveOutcome => ({ id, http: reply === null ? 429 : 200, reply, seconds: 0, busyRetries: 0, note: null });

  it("runs a chain in order and marks the rest not run after a case with no result", async () => {
    const ran: string[] = [];
    const recorded: LiveOutcome[] = [];
    await runLiveGroup(["example_3a", "example_3b", "example_7a"], async (id) => {
      ran.push(id);
      return result(id, id === "example_3b" ? null : { status: "success" });
    }, (outcome) => recorded.push(outcome));
    expect(ran).toEqual(["example_3a", "example_3b"]);
    expect(recorded.map((outcome) => [outcome.id, outcome.reply === null])).toEqual([["example_3a", false], ["example_3b", true], ["example_7a", true]]);
    expect(recorded[2].note).toBe("not run: example_3b in its chain got no result or an unexpected error");
  });

  it("stops a chain after an unexpected error when told what counts", async () => {
    const recorded: LiveOutcome[] = [];
    const errorReply = { status: "error", error: { type: "Timeout" } };
    await runLiveGroup(["example_3a", "example_3b"], async (id) => result(id, errorReply), (outcome) => recorded.push(outcome), (outcome) => outcome.reply?.status !== "error");
    expect(recorded.map((outcome) => [outcome.id, outcome.reply === null])).toEqual([["example_3a", false], ["example_3b", true]]);
  });
});

describe("memorySeen", () => {
  it("labels the ids from the recall line with the reply's memories, and is null without a recall line", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    const file = path.join(tmp, "t.jsonl");
    writeFileSync(file, `${JSON.stringify({ agent_name: "Memory", action: "recall", output_summary: "by_tag=mem-59,mem-52; by_query=mem-3; corrections=mem-59" })}\n`);
    const reply = { output: { memories_recalled: [{ id: "mem-59", tags: ["event:user_correction", "correction"] }, { id: "mem-52", tags: ["review", "run:example_3a"] }, { id: "mem-3", tags: ["rule"] }] } };
    expect(memorySeen(file, reply)).toBe("by_tag=mem-59 (correction), mem-52 (review of example_3a); by_query=mem-3 (rule)");
    writeFileSync(file, `${JSON.stringify({ agent_name: "Orchestrator", action: "run_end" })}\n`);
    expect(memorySeen(file, reply)).toBeNull();
  });
});

describe("runCliCase", () => {
  it("returns a missing fixture as an outcome with no reply, never a throw", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    const outcome = await runCliCase({ id: "x", body: {}, dataDir: "no/such/fixture" }, tmp, tmp, 1000);
    expect(outcome.reply).toBeNull();
    expect(outcome.note).toBe("no/such/fixture is missing: run npm run make-fixtures first");
  });

  it("returns a copy that really fails as an outcome with no reply, and never starts the agent", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    mkdirSync(path.join(tmp, "fixture"));
    writeFileSync(path.join(tmp, "fixture", "locked.json"), "{}");
    chmodSync(path.join(tmp, "fixture", "locked.json"), 0o000);
    let started = 0;
    const spawnAgent: SpawnAgent = async () => {
      started += 1;
      return 0;
    };
    const outcome = await runCliCase({ id: "x", body: {}, dataDir: "fixture" }, tmp, tmp, 1000, { spawnAgent });
    chmodSync(path.join(tmp, "fixture", "locked.json"), 0o600);
    expect(started).toBe(0);
    expect(outcome.reply).toBeNull();
    expect(outcome.note).toMatch(/^npm run agent failed: .*EACCES/);
  });

  it("never takes an old logs/ trace or an old saved trace for this run's", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tradeflow-live-"));
    mkdirSync(path.join(tmp, "fixture"));
    mkdirSync(path.join(tmp, "logs"));
    mkdirSync(path.join(tmp, "out"));
    const recall = `${JSON.stringify({ agent_name: "Memory", action: "recall", output_summary: "by_tag=mem-1; by_query=none" })}\n`;
    writeFileSync(path.join(tmp, "logs", "trace-x.jsonl"), recall);
    utimesSync(path.join(tmp, "logs", "trace-x.jsonl"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    writeFileSync(path.join(tmp, "out", "x.trace.jsonl"), recall);
    const spawnAgent: SpawnAgent = async ({ outDir }) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "x.json"), JSON.stringify({ run_id: "x", status: "success" }));
      return 0;
    };
    const outcome = await runCliCase({ id: "x", body: {}, dataDir: "fixture" }, tmp, path.join(tmp, "out"), 1000, { spawnAgent });
    expect(outcome.reply).toEqual({ run_id: "x", status: "success" });
    expect(outcome.memory).toBeNull();
    expect(outcome.note).toBe("no trace from this run in logs/");
    expect(existsSync(path.join(tmp, "out", "x.trace.jsonl"))).toBe(false);
  });
});
