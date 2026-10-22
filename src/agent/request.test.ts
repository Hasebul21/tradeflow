import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { httpStatusOf, resolveSampleMode, runRequest } from "./request";

// Runs on a temporary copy of data/ through TRADEFLOW_DATA_DIR; every environment variable the config reads is
// set here, so the developer's .env never matters.
const QUESTION = "Why did my portfolio move this week?";
const AS_OF = "2026-10-01";
const KEY_ENV = {
  METERLESS_API_KEY: "test-key-value-not-real",
  METERLESS_BASE_URL: "http://localhost:9/v1",
  NEMOTRON_MODEL_STRONG: "meterless/deep",
  NEMOTRON_MODEL_MAIN: "meterless/auto",
  NEMOTRON_MODEL_FAST: "meterless/fast",
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-request-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  vi.stubEnv("TRADEFLOW_DATA_DIR", dir);
  for (const name of Object.keys(KEY_ENV)) vi.stubEnv(name, "");
  vi.stubEnv("SAMPLE_MODE", "");
  vi.stubEnv("LOG_LEVEL", "error");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) => runRequest(body);

describe("runRequest", () => {
  it("runs explain_week in sample mode and makes a run id when none is given", async () => {
    const result = await post({ input: { question: QUESTION, as_of: AS_OF }, options: { sample_mode: true } });
    expect(result.status).toBe("success");
    expect(result.run_id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(result.output?.summary).toContain("BXPHARMA");
    expect(httpStatusOf(result)).toBe(200);
  });

  it("is sample mode with no key, whether options.sample_mode is false or there is no options object", async () => {
    const off = await post({ run_id: "req-off", input: { question: QUESTION, as_of: AS_OF }, options: { sample_mode: false } });
    const none = await post({ run_id: "req-none", input: { question: QUESTION, as_of: AS_OF } });
    expect([off.status, none.status]).toEqual(["success", "success"]);
    expect(off.output?.model_source).toBe("sample-model");
  });

  it("returns 400 InvalidInput with zero model calls for an empty question, a bad run id, a bad as_of and an unknown task", async () => {
    const cases: unknown[] = [
      { run_id: "req-empty", input: { question: "" } },
      { run_id: "req-nothing", input: {} },
      { run_id: "../etc", input: { question: QUESTION } },
      { run_id: "a".repeat(81), input: { question: QUESTION } },
      { run_id: "req-date", input: { question: QUESTION, as_of: "2030-01-01" } },
      { run_id: "req-bad-date", input: { question: QUESTION, as_of: "yesterday" } },
      { run_id: "req-task", input: { task: "do_anything", question: QUESTION } },
      { run_id: "req-num", input: { question: 7 } },
      "not an object",
      null,
    ];
    for (const body of cases) {
      const result = await post(body);
      expect(result.status, JSON.stringify(body)).toBe("error");
      expect(result.error?.type, JSON.stringify(body)).toBe("InvalidInput");
      expect(result.error?.recoverable).toBe(false);
      expect(result.usage.model_calls).toBe(0);
      expect(httpStatusOf(result)).toBe(400);
    }
  });

  it("returns a 500 error, not a throw, when SAMPLE_MODE=false has no key", async () => {
    vi.stubEnv("SAMPLE_MODE", "false");
    const result = await post({ run_id: "req-real", input: { question: QUESTION, as_of: AS_OF }, options: { sample_mode: true } });
    expect(result.status).toBe("error");
    expect(result.error?.type).toBe("ConfigError");
    expect(result.usage).toMatchObject({ model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0 });
    expect(httpStatusOf(result)).toBe(500);
  });

  it("lets SAMPLE_MODE=true win over options.sample_mode false", async () => {
    vi.stubEnv("SAMPLE_MODE", "true");
    for (const [name, value] of Object.entries(KEY_ENV)) vi.stubEnv(name, value);
    const result = await post({ run_id: "req-true", input: { question: QUESTION, as_of: AS_OF }, options: { sample_mode: false } });
    expect(result.status).toBe("success");
    expect(result.output?.model_source).toBe("sample-model");
  });
});

describe("resolveSampleMode", () => {
  const withKey = { ...KEY_ENV };
  it("follows the rules in AGENTS.md rule 11", () => {
    const none = loadConfig({}, () => {});
    const keyed = loadConfig(withKey, () => {});
    const half = loadConfig({ METERLESS_API_KEY: "test-key-value-not-real" }, () => {});
    expect(resolveSampleMode(none, undefined, {})).toBe(true);
    expect(resolveSampleMode(half, false, { METERLESS_API_KEY: "x" })).toBe(true);
    expect(resolveSampleMode(keyed, undefined, withKey)).toBe(false);
    expect(resolveSampleMode(keyed, false, withKey)).toBe(false);
    expect(resolveSampleMode(keyed, true, withKey)).toBe(true);
    const forcedTrue = loadConfig({ ...withKey, SAMPLE_MODE: "true" }, () => {});
    expect(resolveSampleMode(forcedTrue, false, { ...withKey, SAMPLE_MODE: "true" })).toBe(true);
    const forcedFalse = loadConfig({ ...withKey, SAMPLE_MODE: "false" }, () => {});
    expect(resolveSampleMode(forcedFalse, true, { ...withKey, SAMPLE_MODE: "false" })).toBe(false);
  });
});
