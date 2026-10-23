// Structural checks from .openclaude/rules/harness.md and AGENTS.md that a unit test can prove: agents stay
// independent, a run's limits are numbers in config.ts alone, every prompt ends with worked examples, and every
// setting is named in .env.example with no secret value.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type Env } from "./config";

const AGENT_DIR = path.resolve("src/agent");
const relative = (file: string) => path.relative(AGENT_DIR, file).split(path.sep).join("/");

describe("agent independence", () => {
  it("has an agent file per task and no agent imports another at runtime", () => {
    const agents = ["planner", "analyst", "evaluator", "writer", "router"];
    for (const name of agents) {
      const source = readFileSync(path.resolve("src/agent/agents", `${name}.ts`), "utf8");
      // A type-only import is erased at build time and cannot call a sibling agent; a value import could.
      expect(source.match(/import\s+(?!type\b)[^;]*?from\s+["']\.\//g) ?? [], `${name}.ts value-imports a sibling`).toEqual([]);
      expect(source, `${name}.ts require()s a sibling`).not.toMatch(/require\(\s*["']\.\//);
      expect(source, `${name}.ts calls a sibling agent directly`).not.toMatch(/\b(runPlan|runAnalysis|runEvaluation|runWriter)\s*\(/);
    }
  });
});

describe("limits live in config.ts", () => {
  // The run-limiting names from limitsSchema in config.ts. A literal for any of them elsewhere is a second source
  // of truth for a budget, which harness.md forbids.
  const BUDGET_NAMES = [
    "MAX_ROUNDS",
    "MAX_QUERY_CALLS",
    "MAX_MODEL_CALLS",
    "MAX_PLAN_STEPS",
    "MAX_TOOL_ROUNDS",
    "MAX_TOKENS_PER_RUN",
    "QUERY_TIMEOUT_MS",
    "MODEL_TIMEOUT_MS",
    "MODEL_TIMEOUT_STRONG_MS",
    "ROUND_TIMEOUT_MS",
    "RUN_TIMEOUT_MS",
    "BRIEFING_TIMEOUT_MS",
    "MAX_CONCURRENT_CHILDREN",
    "MAX_CONCURRENT_RUNS",
    "MAX_ROWS_PER_QUERY",
    "MAX_MEMORIES",
    "MAX_PROMPT_CHARS",
    "MAX_TOOL_CALLS_PER_ROUND",
    "MAX_FIX_CHARS",
    "MAX_COMPLETION_TOKENS",
  ];

  it("declares no budget as a literal outside config.ts", () => {
    const files = (readdirSync(AGENT_DIR, { recursive: true }) as string[])
      .map((file) => path.join(AGENT_DIR, file))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => path.basename(file) !== "config.ts");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const name of BUDGET_NAMES) {
        expect(source, `${relative(file)} sets ${name} to a literal`).not.toMatch(new RegExp(`\\b${name}\\b\\s*[:=]\\s*\\d`));
      }
    }
  });

  it("reads every limit through loadConfig", () => {
    const config = loadConfig({}, () => {});
    for (const name of BUDGET_NAMES) expect(config[name as keyof typeof config], name).toEqual(expect.any(Number));
  });
});

describe("prompts end with worked examples", () => {
  it("gives every prompt an Examples section on the made-up holding", () => {
    const dir = path.resolve("src/agent/prompts");
    const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
    expect(files.sort()).toEqual(["analyst.md", "evaluator.md", "planner.md", "router.md", "writer.md"]);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text, `${file} has no ## Examples heading`).toMatch(/^## Examples$/m);
      expect(text, `${file} never names the made-up holding`).toContain("ACMEPHARMA");
    }
  });
});

describe("settings are documented without values", () => {
  it("names every setting config.ts reads in the example file, with no secret value", () => {
    const seen = new Set<string>();
    const env = new Proxy({} as Env, {
      get(_target, key) {
        if (typeof key === "string") seen.add(key);
        return undefined;
      },
    });
    loadConfig(env, () => {});

    // A few names are read only when another is set (the Zetaris user and password follow its URL, org and key), so
    // an empty environment never touches them. Scan the source for every read(env, "NAME", ...) call as well.
    const source = readFileSync(path.resolve("src/agent/config.ts"), "utf8");
    for (const call of source.matchAll(/read\(env,\s*([^)]*)\)/g)) {
      for (const quoted of call[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)) seen.add(quoted[1]);
    }

    const example = readFileSync(path.resolve(".env.example"), "utf8");
    const entries = [...example.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((match) => ({ name: match[1], value: match[2].trim() }));
    const documented = new Set(entries.map((entry) => entry.name));

    // The primary names: the key, the base URL, the three tiers and the Zetaris client. The aliases config.ts also
    // accepts (METERLESS_RUNTIME_TOKEN, MODEL_NAME, ...) are compatibility names, not new settings to document.
    const primary = [
      "SAMPLE_MODE",
      "METERLESS_API_KEY",
      "METERLESS_BASE_URL",
      "NEMOTRON_MODEL_STRONG",
      "NEMOTRON_MODEL_MAIN",
      "NEMOTRON_MODEL_FAST",
      "ZETARIS_REST_URL",
      "ZETARIS_ORG_ID",
      "ZETARIS_API_KEY",
      "ZETARIS_USERNAME",
      "ZETARIS_PASSWORD",
      "LOG_LEVEL",
      "PORT",
    ];
    for (const name of primary) {
      expect(seen.has(name), `config.ts never reads ${name}`).toBe(true);
      expect(documented.has(name), `${name} is missing from .env.example`).toBe(true);
    }

    // A key, password, token or URL line carries no value: the example names the setting; .env holds the secret.
    for (const entry of entries) {
      if (/(KEY|PASS|TOKEN|SECRET|URL)/.test(entry.name)) expect(entry.value, `${entry.name} has a value`).toBe("");
    }
  });
});
