import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "./config";
import type { Finding } from "./guards";
import { PromptTooLarge, type CompleteOptions, type CompleteResult, type HistoryMessage } from "./llm";
import { run, type RunResult } from "./orchestrator";
import type { TraceLine } from "./trace";

// MAX_PROMPT_CHARS on the runs that reach it. Each prompt is counted as llm.ts counts it: system, user and history.
// A stub replaces one agent's reply and wraps the sample model, so llm.ts still checks each prompt and writes its
// model_call line. Every run gets its own copy of data/, so a limit measured on one run holds for the next.
type Actual = (options: CompleteOptions) => Promise<CompleteResult>;
type Override = (options: CompleteOptions, actual: Actual) => Promise<CompleteResult | null>;
const stubs = vi.hoisted(() => ({ override: null as Override | null }));

vi.mock("./sample-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sample-model")>();
  const complete = async (options: CompleteOptions): Promise<CompleteResult> => {
    const override = stubs.override;
    if (override !== null) {
      const result = await override(options, actual.complete);
      if (result !== null) return result;
    }
    return actual.complete(options);
  };
  return { ...actual, complete };
});

const AS_OF = "2026-10-01";
const THESIS_QUESTION = "Do my reasons for each trade still hold?";
const WEEK_QUESTION = "Why did my portfolio move this week?";
const config = loadConfig({ SAMPLE_MODE: "true" }, () => {});

const dirs: string[] = [];
/** A fresh copy of data/ for the next run, so every run starts from the same state. */
async function freshData(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "tradeflow-prompt-size-"));
  dirs.push(dir);
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
}

afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  stubs.override = null;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const historyChars = (history: readonly HistoryMessage[] = []) => history.reduce((n, message) => n + JSON.stringify(message).length, 0);
/** The prompt size llm.ts checks: system, user and history. */
const promptChars = (call: CompleteOptions) => call.system.length + call.user.length + historyChars(call.history);

const trace = (result: RunResult): TraceLine[] =>
  readFileSync(path.resolve(result.log_file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);

const configWith = (limit: number): Config => loadConfig({ SAMPLE_MODE: "true", MAX_PROMPT_CHARS: String(limit) }, () => {});

type Thesis = { journal_id: string; fundamentals_run_query_id: string | null };

/**
 * The live run's shape: each of the first round's two batches gets a wrong claim (a figure no row holds, a dividend
 * with no row), so the Evaluator rejects the draft and round 2 reruns both batches. Records every Analyst call.
 */
function thesisRound1Errors(calls: CompleteOptions[]): void {
  stubs.override = async (options, actual) => {
    if (options.agent !== "Analyst") return null;
    calls.push(options);
    const result = await actual(options);
    if (calls.length > 2) return result;
    const theses = (JSON.parse(options.user) as { theses: Thesis[] }).theses;
    const cites = (id: string) => [theses.find((thesis) => thesis.journal_id === id)!.fundamentals_run_query_id!];
    const findings = ((result.json?.findings ?? []) as Finding[]).map((finding) => {
      if (finding.subject === "j-026") return { ...finding, numbers: [], cites: cites("j-026"), claim: "Open: the holding is 24.71% of the portfolio, approaching the 25% trim threshold; the exit condition 'Trim if it goes above 25%' is not yet met." };
      if (finding.subject === "j-005") return { ...finding, numbers: [], cites: cites("j-005"), claim: "Confirmed: the dividend of Tk 18.00 per share was paid on 2026-07-12, so the thesis of buying for the dividend is still supported." };
      return finding;
    });
    const json = { ...(result.json ?? {}), findings };
    return { ...result, json, text: JSON.stringify(json) };
  };
}

describe("thesis_check: a rerun whose previous findings outgrow MAX_PROMPT_CHARS (23 Oct, example_5)", () => {
  it("sends a rerun only the previous findings the fix flags, and the run ends success, not error", async () => {
    // The limit sits just above the largest first-round prompt. A round-2 rerun of batch 2 with its 15 previous findings
    // goes over it, as in the live run; with only the flagged ones it fits.
    await freshData();
    const dry: CompleteOptions[] = [];
    thesisRound1Errors(dry);
    await run({ runId: "prompt-size-dry", task: "thesis_check", input: { question: THESIS_QUESTION, as_of: AS_OF }, sampleMode: true, config });
    const limit = Math.max(...dry.slice(0, 2).map(promptChars)) + 2000;
    // With no limit to meet, nothing is cut: the rerun's prompt as the live run built it.
    await freshData();
    const whole: CompleteOptions[] = [];
    thesisRound1Errors(whole);
    await run({ runId: "prompt-size-whole", task: "thesis_check", input: { question: THESIS_QUESTION, as_of: AS_OF }, sampleMode: true, config: configWith(1_000_000) });
    expect(promptChars(whole[3])).toBeGreaterThan(limit);

    await freshData();
    const calls: CompleteOptions[] = [];
    thesisRound1Errors(calls);
    const result = await run({ runId: "prompt-size-thesis", task: "thesis_check", input: { question: THESIS_QUESTION, as_of: AS_OF }, sampleMode: true, config: configWith(limit) });

    expect(result.status, result.error?.message).toBe("success");
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(promptChars(call)).toBeLessThanOrEqual(limit);

    // The rerun of batch 2 shows the fix's flagged findings only; code keeps the rest, as the Analyst prompt says.
    const user = JSON.parse(calls[3].user) as { previous_findings: Finding[]; flagged_findings: { kind: string; subject: string }[] };
    expect(user.flagged_findings.length).toBeGreaterThan(0);
    expect(user.previous_findings.length).toBeLessThan(15);
    for (const finding of user.previous_findings) {
      expect(user.flagged_findings.some((flag) => flag.kind === finding.kind && flag.subject === finding.subject)).toBe(true);
    }
    const cut = trace(result).filter((line) => line.agent_name === "Analyst" && line.action === "previous_left_out");
    expect(cut).toEqual([expect.objectContaining({ retry_count: 1, status: "ok", input_summary: expect.stringMatching(/^round 2: \d+ of \d+ previous findings, \d+ flagged$/) })]);
  });

  it("a PromptTooLarge on the second Analyst call ends needs_human with model_unavailable and a trace line that says the prompt was too large", async () => {
    await freshData();
    let analystCalls = 0;
    stubs.override = async (options) => {
      if (options.agent !== "Analyst") return null;
      analystCalls += 1;
      if (analystCalls === 2) {
        throw new PromptTooLarge("The prompt is 45480 characters (system, user and history), over MAX_PROMPT_CHARS (40000). It is never cut silently.");
      }
      return null;
    };
    const result = await run({ runId: "prompt-size-second-call", task: "thesis_check", input: { question: THESIS_QUESTION, as_of: AS_OF }, sampleMode: true, config });

    expect(result.status).toBe("needs_human");
    expect(result.error).toBeNull();
    expect(result.output).toMatchObject({ partial: true, stop_reason: "model_unavailable", needs_human: true });
    const lines = trace(result);
    const fallback = lines.filter((line) => line.agent_name === "Orchestrator" && line.action === "model_unavailable_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ status: "fallback", stop_reason: "model_unavailable" });
    expect(fallback[0].why).toContain("PromptTooLarge");
    expect(fallback[0].why).toContain("Analyst");
    expect(lines.at(-1)).toMatchObject({ agent_name: "Orchestrator", action: "run_end", status: "needs_human", stop_reason: "model_unavailable" });
  });

  it("a PromptTooLarge whose system prompt alone is too large still ends as a status error, the one case that may", async () => {
    await freshData();
    stubs.override = async (options) => {
      if (options.agent !== "Analyst") return null;
      throw new PromptTooLarge("The system prompt alone is over MAX_PROMPT_CHARS.", true);
    };
    const result = await run({ runId: "prompt-size-system-alone", task: "thesis_check", input: { question: THESIS_QUESTION, as_of: AS_OF }, sampleMode: true, config });

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ type: "PromptTooLarge" });
  });
});

describe("explain_week: tool results that outgrow the room for another round", () => {
  /** Every Analyst call; while tools are offered, the reply asks for fundamentals_latest, as a model would. */
  function askingForTools(calls: CompleteOptions[]): void {
    let asked = 0;
    stubs.override = async (options, actual) => {
      if (options.agent !== "Analyst") return null;
      calls.push(options);
      if (options.tools === undefined) return actual(options);
      asked += 1;
      return {
        text: null,
        json: null,
        usage: { tokens_in: 10, tokens_out: 5 },
        duration_ms: 1,
        model_id: "stub",
        source: "sample-model",
        tool_calls: [{ id: `call-${asked}`, name: "fundamentals_latest", arguments: { symbol: "BXPHARMA", as_of: AS_OF } }],
      };
    };
  }

  it("with the default limits, a tool round whose worst case no longer fits stops the tools, traces it, and the run succeeds", async () => {
    await freshData();
    const calls: CompleteOptions[] = [];
    askingForTools(calls);
    const result = await run({ runId: "prompt-size-tools-default", task: "explain_week", input: { question: WEEK_QUESTION, as_of: AS_OF }, sampleMode: true, config });

    expect(result.status, result.error?.message).toBe("success");
    expect(calls[0].tools).toBeDefined();
    expect(calls[1].tools).toBeUndefined();
    const stopped = trace(result).filter((line) => line.agent_name === "Analyst" && line.action === "tool_rounds_stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0].why).toContain("MAX_PROMPT_CHARS");
  });

  it("with a limit one tool round too small, no call goes over MAX_PROMPT_CHARS and the run succeeds", async () => {
    // The second call carries the first round's result in its history. A limit at that size leaves no room for a
    // second tool round, so the second call must answer without tools. Without the check, its tool round would
    // grow the history past the limit on the third call.
    await freshData();
    const dry: CompleteOptions[] = [];
    askingForTools(dry);
    await run({ runId: "prompt-size-tools-dry", task: "explain_week", input: { question: WEEK_QUESTION, as_of: AS_OF }, sampleMode: true, config });
    const limit = promptChars(dry[1]);

    await freshData();
    const calls: CompleteOptions[] = [];
    askingForTools(calls);
    const result = await run({ runId: "prompt-size-tools", task: "explain_week", input: { question: WEEK_QUESTION, as_of: AS_OF }, sampleMode: true, config: configWith(limit) });

    expect(result.status, result.error?.message).toBe("success");
    for (const call of calls) expect(promptChars(call)).toBeLessThanOrEqual(limit);
    expect(calls).toHaveLength(2);
    expect(calls[1].tools).toBeUndefined();
    expect(calls[1].history?.length).toBeGreaterThan(0);
    expect(trace(result).filter((line) => line.agent_name === "Analyst" && line.action === "tool_rounds_stopped")).toHaveLength(1);
  });
});
