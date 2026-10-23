import { describe, expect, it, vi } from "vitest";
import { ConfigError, EMPTY_RESPONSE_RETRY_MAX_TOKENS, loadConfig, MODEL_TIMEOUT_CAP_MS } from "./config";

// Made-up values only: no real endpoint, model id or key appears here.
const BASE = "https://example.test/v1";
const MODELS = { NEMOTRON_MODEL_STRONG: "a", NEMOTRON_MODEL_MAIN: "b", NEMOTRON_MODEL_FAST: "c" };
const real = { METERLESS_API_KEY: "test-key", METERLESS_BASE_URL: BASE, ...MODELS };

describe("limits and defaults", () => {
  it("gives every default with no environment", () => {
    const cfg = loadConfig({}, () => {});
    expect(cfg).toMatchObject({
      MAX_ROUNDS: 3,
      MAX_QUERY_CALLS: 20,
      MAX_MODEL_CALLS: 12,
      MAX_PLAN_STEPS: 5,
      MAX_TOOL_ROUNDS: 2,
      MAX_TOKENS_PER_RUN: 250000,
      QUERY_TIMEOUT_MS: 20000,
      MODEL_TIMEOUT_MS: 240000,
      MODEL_TIMEOUT_STRONG_MS: 240000,
      ROUND_TIMEOUT_MS: 360000,
      RUN_TIMEOUT_MS: 900000,
      MAX_ROWS_PER_QUERY: 50,
      MAX_MEMORIES: 5,
      MAX_PROMPT_CHARS: 40000,
      TEMPERATURE: 0.2,
      MAX_COMPLETION_TOKENS: 16000,
      PORT: 8000,
      LOG_LEVEL: "info",
    });
    expect(cfg.METERLESS_BASE_URL).toBeUndefined();
    expect(cfg.NEMOTRON_MODEL_STRONG).toBeUndefined();
    expect(cfg.models.strong).toBeUndefined();
  });

  it("clamps a model timeout above 240000 to 240000", () => {
    const cfg = loadConfig({ MODEL_TIMEOUT_MS: "999999", MODEL_TIMEOUT_STRONG_MS: "999999" }, () => {});
    expect(cfg.MODEL_TIMEOUT_MS).toBe(240000);
    expect(cfg.MODEL_TIMEOUT_STRONG_MS).toBe(240000);
  });

  it("sets the model-call cap to 240000 and keeps the empty-reply retry at 32000 tokens", () => {
    expect(MODEL_TIMEOUT_CAP_MS).toBe(240000);
    expect(EMPTY_RESPONSE_RETRY_MAX_TOKENS).toBe(32000);
  });

  it("keeps a model timeout below the cap", () => {
    expect(loadConfig({ MODEL_TIMEOUT_MS: "120000" }, () => {}).MODEL_TIMEOUT_MS).toBe(120000);
  });

  it("overrides a limit from the environment as a number", () => {
    const cfg = loadConfig({ MAX_ROUNDS: "2", TEMPERATURE: "0" }, () => {});
    expect(cfg.MAX_ROUNDS).toBe(2);
    expect(cfg.TEMPERATURE).toBe(0);
  });

  it("counts an empty limit as unset", () => {
    expect(loadConfig({ MAX_ROUNDS: "" }, () => {}).MAX_ROUNDS).toBe(3);
  });

  it("throws a ConfigError naming a limit that is not a number", () => {
    expect(() => loadConfig({ MAX_ROUNDS: "many" }, () => {})).toThrow(/MAX_ROUNDS/);
    expect(() => loadConfig({ MAX_ROUNDS: "0" }, () => {})).toThrow(ConfigError);
  });
});

describe("base URL and model ids", () => {
  it("returns the values passed in, with no default in code", () => {
    const cfg = loadConfig({ METERLESS_BASE_URL: BASE, NEMOTRON_MODEL_STRONG: "test-model-id" }, () => {});
    expect(cfg.METERLESS_BASE_URL).toBe(BASE);
    expect(cfg.models.strong).toBe("test-model-id");
    expect(cfg.NEMOTRON_MODEL_STRONG).toBe("test-model-id");
  });

  it("reads MODEL_BASE_URL as an alias and strips the trailing slash", () => {
    const cfg = loadConfig({ METERLESS_API_KEY: "test-key", MODEL_BASE_URL: "https://example.test/v1/", ...MODELS }, () => {});
    expect(cfg.sampleMode).toBe(false);
    expect(cfg.METERLESS_BASE_URL).toBe(BASE);
  });

  it.each(["https://example.test", "https://example.test/", "https://example.test/v1", "https://example.test/v1/"])(
    "normalises %s to one value",
    (url) => {
      expect(loadConfig({ ...real, METERLESS_BASE_URL: url }, () => {}).METERLESS_BASE_URL).toBe(BASE);
    },
  );

  it.each(["MODEL_NAME", "METERLESS_MODEL", "NEMOTRON_MODEL"])("reads %s as the main model", (alias) => {
    const cfg = loadConfig(
      { METERLESS_API_KEY: "test-key", METERLESS_BASE_URL: BASE, NEMOTRON_MODEL_STRONG: "a", [alias]: "b", NEMOTRON_MODEL_FAST: "c" },
      () => {},
    );
    expect(cfg.sampleMode).toBe(false);
    expect(cfg.models.main).toBe("b");
  });
});

describe("key aliases", () => {
  it.each(["MODEL_API_KEY", "METERLESS_RUNTIME_TOKEN"])("reads %s as the key", (alias) => {
    const cfg = loadConfig({ [alias]: "test-key", METERLESS_BASE_URL: BASE, ...MODELS }, () => {});
    expect(cfg.sampleMode).toBe(false);
  });

  it("does not read NVIDIA_API_KEY", () => {
    const cfg = loadConfig({ NVIDIA_API_KEY: "test-key", METERLESS_BASE_URL: BASE, ...MODELS }, () => {});
    expect(cfg.sampleMode).toBe(true);
    expect(cfg.METERLESS_API_KEY).toBeUndefined();
  });

  it("rejects the rt-local placeholder token", () => {
    expect(loadConfig({ ...real, METERLESS_API_KEY: "rt-local" }, () => {}).sampleMode).toBe(true);
    expect(() => loadConfig({ ...real, METERLESS_API_KEY: "rt-local", SAMPLE_MODE: "false" }, () => {})).toThrow(/METERLESS_API_KEY/);
  });
});

describe("precedence", () => {
  it("prefers METERLESS_API_KEY, then METERLESS_RUNTIME_TOKEN, then MODEL_API_KEY", () => {
    const all = { METERLESS_API_KEY: "first", METERLESS_RUNTIME_TOKEN: "second", MODEL_API_KEY: "third" };
    expect(loadConfig(all, () => {}).METERLESS_API_KEY).toBe("first");
    expect(loadConfig({ METERLESS_RUNTIME_TOKEN: "second", MODEL_API_KEY: "third" }, () => {}).METERLESS_API_KEY).toBe("second");
    expect(loadConfig({ MODEL_API_KEY: "third" }, () => {}).METERLESS_API_KEY).toBe("third");
  });

  it("prefers METERLESS_BASE_URL over MODEL_BASE_URL", () => {
    const cfg = loadConfig({ METERLESS_BASE_URL: "https://one.test/v1", MODEL_BASE_URL: "https://two.test/v1" }, () => {});
    expect(cfg.METERLESS_BASE_URL).toBe("https://one.test/v1");
  });

  it("prefers NEMOTRON_MODEL_MAIN, then METERLESS_MODEL, NEMOTRON_MODEL and MODEL_NAME", () => {
    const env: Record<string, string | undefined> = {
      NEMOTRON_MODEL_MAIN: "b1",
      METERLESS_MODEL: "b2",
      NEMOTRON_MODEL: "b3",
      MODEL_NAME: "b4",
    };
    for (const [removed, expected] of [[null, "b1"], ["NEMOTRON_MODEL_MAIN", "b2"], ["METERLESS_MODEL", "b3"], ["NEMOTRON_MODEL", "b4"]] as const) {
      if (removed) delete env[removed];
      expect(loadConfig(env, () => {}).models.main).toBe(expected);
    }
  });

  it("lets an empty canonical name fall through to its alias", () => {
    expect(loadConfig({ METERLESS_API_KEY: "", MODEL_API_KEY: "third" }, () => {}).METERLESS_API_KEY).toBe("third");
  });
});

describe("sample mode", () => {
  it("is on with no key, and logs the reason once per call", () => {
    for (const env of [{}, { METERLESS_API_KEY: "", SAMPLE_MODE: "" }]) {
      const log = vi.fn();
      expect(loadConfig(env, log).sampleMode).toBe(true);
      const reasons = log.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("METERLESS_API_KEY"));
      expect(reasons).toHaveLength(1);
    }
  });

  it("logs the Zetaris reason once, apart from the sample-mode reason", () => {
    const log = vi.fn();
    loadConfig({}, log);
    const zetaris = log.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("ZETARIS_REST_URL"));
    expect(zetaris).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("logs nothing at LOG_LEVEL error", () => {
    const log = vi.fn();
    loadConfig({ LOG_LEVEL: "error" }, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("is on when SAMPLE_MODE is true, even with a full real setup", () => {
    expect(loadConfig({ ...real, SAMPLE_MODE: "true" }, () => {}).sampleMode).toBe(true);
    expect(loadConfig({ SAMPLE_MODE: "true", METERLESS_API_KEY: "test-key" }, () => {}).sampleMode).toBe(true);
  });

  it("is off with a full real setup and SAMPLE_MODE empty or false", () => {
    expect(loadConfig(real, () => {}).sampleMode).toBe(false);
    expect(loadConfig({ ...real, SAMPLE_MODE: "false" }, () => {}).sampleMode).toBe(false);
  });

  it("throws a ConfigError naming METERLESS_API_KEY when SAMPLE_MODE is false and the key is missing", () => {
    const attempt = () => loadConfig({ SAMPLE_MODE: "false" }, () => {});
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/METERLESS_API_KEY/);
  });

  it("counts a key without a base URL as no key, and logs the reason once", () => {
    const log = vi.fn();
    expect(loadConfig({ METERLESS_API_KEY: "test-key" }, log).sampleMode).toBe(true);
    const reasons = log.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("METERLESS_BASE_URL"));
    expect(reasons).toHaveLength(1);
  });

  it("counts a key without a model id as no key, and names the variable when SAMPLE_MODE is false", () => {
    const env = { METERLESS_API_KEY: "test-key", METERLESS_BASE_URL: BASE, NEMOTRON_MODEL_STRONG: "test-strong", NEMOTRON_MODEL_FAST: "test-fast" };
    expect(loadConfig(env, () => {}).sampleMode).toBe(true);
    expect(() => loadConfig({ ...env, SAMPLE_MODE: "false" }, () => {})).toThrow(/NEMOTRON_MODEL_MAIN/);
  });

  it("never puts the key value in an error or a log line", () => {
    const log = vi.fn();
    loadConfig({ METERLESS_API_KEY: "secret-value-123" }, log);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-value-123");
    let message = "";
    try {
      loadConfig({ METERLESS_API_KEY: "secret-value-123", SAMPLE_MODE: "false" }, () => {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("NEMOTRON_MODEL_MAIN");
    expect(message).not.toContain("secret-value-123");
  });

  it("throws on a SAMPLE_MODE value that is neither true nor false", () => {
    expect(() => loadConfig({ SAMPLE_MODE: "maybe" }, () => {})).toThrow(/SAMPLE_MODE/);
  });
});

describe("Zetaris", () => {
  it("is configured only when the URL, org id and API key are all set", () => {
    const env = { ZETARIS_REST_URL: "https://zetaris.test", ZETARIS_ORG_ID: "1", ZETARIS_API_KEY: "test-key" };
    expect(loadConfig(env, () => {}).zetaris).toMatchObject({ restUrl: "https://zetaris.test", orgId: "1", apiKey: "test-key" });
    expect(loadConfig({ ...env, ZETARIS_ORG_ID: "" }, () => {}).zetaris).toBeNull();
  });
});
