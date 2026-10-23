import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promptVersion } from "./prompts";

const sha8 = (name: string) => createHash("sha256").update(readFileSync(path.resolve("src/agent/prompts", `${name}.md`), "utf8")).digest("hex").slice(0, 8);

describe("promptVersion", () => {
  it("returns the file's text and the first 8 hex characters of its SHA-256", () => {
    const planner = promptVersion("planner");
    expect(planner.text).toBe(readFileSync(path.resolve("src/agent/prompts/planner.md"), "utf8"));
    expect(planner.prompt_hash).toBe(sha8("planner"));
    expect(planner.prompt_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gives each prompt file its own hash", () => {
    const names = ["planner", "analyst", "evaluator", "writer", "router"];
    expect(new Set(names.map((name) => promptVersion(name).prompt_hash)).size).toBe(names.length);
    expect(promptVersion("planner").prompt_hash).not.toBe(promptVersion("analyst").prompt_hash);
  });

  it("computes a file once per process", () => {
    expect(promptVersion("writer")).toBe(promptVersion("writer"));
  });
});
