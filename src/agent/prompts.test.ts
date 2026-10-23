import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findingSchema } from "./guards";
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

/** The balanced {...} object that starts at `from`, string-aware, or null when it never closes. */
function objectAt(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && (depth -= 1) === 0) return text.slice(from, at + 1);
  }
  return null;
}

/** Every finding written as a JSON example in a prompt: the items of each {"findings": [...]} reply and each "Finding: {...}" line. */
function findingExamples(text: string): unknown[] {
  const starts = [...text.matchAll(/\{\s*"findings"\s*:/g)].map((match) => ({ at: match.index!, whole: true }));
  for (const match of text.matchAll(/^Finding: (?=\{)/gm)) starts.push({ at: match.index! + match[0].length, whole: false });
  return starts.flatMap(({ at, whole }) => {
    const source = objectAt(text, at);
    if (source === null) throw new Error(`an unclosed JSON example at offset ${at}`);
    const parsed: unknown = JSON.parse(source);
    return whole ? (parsed as { findings: unknown[] }).findings : [parsed];
  });
}

describe("the JSON examples in the prompts", () => {
  const dir = path.resolve("src/agent/prompts");
  const files = readdirSync(dir).filter((name) => name.endsWith(".md"));

  it("finds the finding examples of the Analyst prompt", () => {
    expect(findingExamples(readFileSync(path.join(dir, "analyst.md"), "utf8")).length).toBeGreaterThanOrEqual(6);
  });

  for (const name of files) {
    it(`${name}: every finding example passes the guards' finding schema`, () => {
      for (const example of findingExamples(readFileSync(path.join(dir, name), "utf8"))) {
        const parsed = findingSchema.safeParse(example);
        expect(parsed.success, `${name}: ${JSON.stringify(example).slice(0, 80)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      }
    });
  }

  it("keeps findings out of the other prompts, whose replies have their own schemas", () => {
    for (const name of files.filter((file) => file !== "analyst.md")) {
      expect(findingExamples(readFileSync(path.join(dir, name), "utf8")), name).toEqual([]);
    }
  });
});
