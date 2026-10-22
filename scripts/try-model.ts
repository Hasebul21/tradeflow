// Sends one short Planner input through complete() and prints what came back. Run it with
// `npm run try-model [-- --strong|--fast]`. It stands in for the Planner and prints no key.
// Loaded by tsx as CommonJS: an async main(), no top-level await.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type Tier } from "../src/agent/config";
import { complete, ModelError, NightshiftNotRunning, RateLimited, Unauthorized } from "../src/agent/llm";
import type { TraceInput } from "../src/agent/trace";

const INPUT = { task: "explain_week", question: "Why did my portfolio move this week?", as_of: "2026-10-01" };

function tierFromArgs(args: string[]): Tier {
  if (args.includes("--strong")) return "strong";
  if (args.includes("--fast")) return "fast";
  return "main";
}

const show = (value: unknown): string => (value === undefined || value === null || value === "" ? "none" : String(value));

async function main(): Promise<number> {
  const tier = tierFromArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const system = readFileSync(path.join(process.cwd(), "src/agent/prompts/planner.md"), "utf8");
  const lines: TraceInput[] = [];
  const tracer = {
    log: (line: TraceInput) => {
      lines.push(line);
      return line as never;
    },
  };

  const requested = cfg.models[tier];
  if (cfg.sampleMode) {
    const forced = (process.env.SAMPLE_MODE ?? "").trim().toLowerCase() === "true";
    console.log(`mode: sample mode (${forced ? "SAMPLE_MODE=true" : "METERLESS_API_KEY, METERLESS_BASE_URL or a NEMOTRON_MODEL_* is missing"})`);
  }
  console.log(`tier: ${tier}`);
  console.log(`requested: ${show(cfg.sampleMode ? undefined : requested)}`);

  try {
    const result = await complete({ system, user: JSON.stringify(INPUT), model: tier, json: true, agent: "Planner", tracer, config: cfg });
    const reportsNemotron = /nemotron/i.test(result.routed_model ?? result.model_id);
    console.log(`source: ${result.source}`);
    console.log(`reported model: ${show(result.model_id)}`);
    console.log(`routed_model: ${show(result.routed_model)}  cost_usd: ${show(result.cost_usd)}`);
    console.log(`looks like Nemotron: ${reportsNemotron ? "yes" : "no"}`);
    console.log(`fallback: ${show(result.fallback)}`);
    console.log(`parsed: ${result.json !== undefined && result.json !== null}`);
    console.log(`usage: ${result.usage === null ? "none" : JSON.stringify(result.usage)}`);
    console.log(`duration_ms: ${result.duration_ms}`);
    if (tier === "fast" && result.source === "nemotron") {
      const rejected = lines.some((line) => line.action === "reasoning_switch_unsupported");
      console.log(`enable_thinking accepted: ${rejected ? "no (the API rejected it; resent without it)" : "yes"}`);
    }
    return 0;
  } catch (error) {
    // A provider or environment problem is reported, not treated as a bug in the code.
    if (error instanceof Unauthorized) console.log("result: unauthorized (the provider rejected the token, HTTP 401 or 403)");
    else if (error instanceof NightshiftNotRunning) console.log("result: Nightshift not running");
    else if (error instanceof RateLimited) console.log("result: rate limited (HTTP 429)");
    else {
      console.log(`result: error ${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}`);
      return error instanceof ModelError ? 0 : 1;
    }
    return 0;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`try-model failed: ${error instanceof Error ? error.name : "Error"}`);
    process.exit(1);
  },
);
