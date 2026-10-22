import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRunId, SECRET_PATTERN, startRun } from "./trace";

const FIELDS = [
  "timestamp",
  "run_id",
  "agent_name",
  "action",
  "input_summary",
  "output_summary",
  "target_agent",
  "model",
  "confidence",
  "retry_count",
  "status",
];
const IDS = ["test-run", "test-run-task", "test-run-mask", "test-run-defaults"];
const fileFor = (id: string) => path.resolve(process.cwd(), "logs", `trace-${id}.jsonl`);
const readLines = (id: string) =>
  readFileSync(fileFor(id), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const step = { agent_name: "Planner", action: "plan", input_summary: "in", output_summary: "out", status: "ok" } as const;

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const id of IDS) rmSync(fileFor(id), { force: true });
});

describe("startRun", () => {
  it("replaces a file with the same run id, so each file holds one run", () => {
    startRun("test-run").log(step);
    const second = startRun("test-run");
    second.log(step);
    second.log({ ...step, action: "again" });
    expect(existsSync(fileFor("test-run"))).toBe(true);
    const lines = readLines("test-run");
    expect(lines).toHaveLength(2);
    for (const line of lines) for (const field of FIELDS) expect(line).toHaveProperty(field);
  });

  it("keeps the file when setTask is called twice, and writes the later task", () => {
    const tracer = startRun("test-run-task");
    tracer.setTask("router");
    tracer.log(step);
    tracer.setTask("explain_week");
    tracer.log(step);
    const lines = readLines("test-run-task");
    expect(lines).toHaveLength(2);
    expect(lines[0].task).toBe("router");
    expect(lines[1].task).toBe("explain_week");
  });

  it("keeps the task per tracer, not per module", () => {
    const one = startRun("test-run");
    const two = startRun("test-run-task");
    one.setTask("explain_week");
    two.log(step);
    expect(readLines("test-run-task")[0]).not.toHaveProperty("task");
  });

  it("fills the defaults: null target, model and confidence, and round 0", () => {
    startRun("test-run-defaults").log(step);
    expect(readLines("test-run-defaults")[0]).toMatchObject({ target_agent: null, model: null, confidence: null, retry_count: 0 });
  });

  it("refuses a run id that is a path", () => {
    expect(() => startRun("../x")).toThrow(/Invalid run id/);
    expect(isRunId("../x")).toBe(false);
    expect(isRunId(".hidden")).toBe(false);
    expect(isRunId("run-20261022-110000-abc123")).toBe(true);
  });
});

describe("masking", () => {
  it("masks an nvapi- key and a 12-plus character secret value, and leaves a 5-character value", () => {
    const nvapi = `nvapi-${"A".repeat(24)}`;
    const stubbed = "k".repeat(16);
    vi.stubEnv("METERLESS_API_KEY", stubbed);
    vi.stubEnv("PGPASS", "abcde");
    const tracer = startRun("test-run-mask");
    tracer.log({ ...step, input_summary: `header ${nvapi}`, output_summary: `token ${stubbed} and pass abcde` });
    const text = readFileSync(fileFor("test-run-mask"), "utf8");
    expect(text).not.toContain(nvapi);
    expect(text).not.toContain(stubbed);
    expect(text).toContain("abcde");
    expect(text).toContain("[masked]");
  });

  it("masks inside nested usage and keeps the character before an sk- key", () => {
    const sk = `sk-${"B".repeat(24)}`;
    const tracer = startRun("test-run-mask");
    tracer.log({ ...step, why: `key=${sk}`, usage: { tokens_in: 1, tokens_out: 2 } });
    const line = readLines("test-run-mask")[0];
    expect(line.why).toBe("key=[masked]");
    expect(line.usage).toEqual({ tokens_in: 1, tokens_out: 2 });
  });
});

describe("secret pattern", () => {
  it("is the same pattern as the one in .cursor/hooks/guard-prompt.mjs", () => {
    const hook = readFileSync(path.resolve(process.cwd(), ".cursor/hooks/guard-prompt.mjs"), "utf8");
    const literal = hook.match(/const key = \/(.*)\/;/)?.[1];
    expect(literal).toBeDefined();
    expect(new RegExp(literal as string).source).toBe(SECRET_PATTERN.source);
  });
});
