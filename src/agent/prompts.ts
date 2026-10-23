// The prompt files in src/agent/prompts/, read as-is, each with a short hash of its text. The hash goes on every
// model trace line (llm.ts) and into the metrics, so a result names the prompt version that produced it. Server only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type PromptVersion = { text: string; prompt_hash: string };

/** Hex characters of the SHA-256 that make the hash: enough to tell versions apart on one line. */
export const PROMPT_HASH_LENGTH = 8;

const cache = new Map<string, PromptVersion>();

/** The text of src/agent/prompts/<name>.md and the first 8 hex characters of its SHA-256, computed once per process per file. */
export function promptVersion(name: string): PromptVersion {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(path.resolve(process.cwd(), "src/agent/prompts", `${name}.md`), "utf8");
  const version = { text, prompt_hash: createHash("sha256").update(text).digest("hex").slice(0, PROMPT_HASH_LENGTH) };
  cache.set(name, version);
  return version;
}
