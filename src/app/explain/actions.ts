"use server";

// Server actions for the Explain page. Each one runs the orchestrator in-process through runRequest and sends
// input.task explicitly. None of them saves a trade or changes the ledger. They never throw: a failure is an
// error result.
import type { RunResult } from "@/agent/orchestrator";
import { runRequest } from "@/agent/request";

async function send(runId: string, input: Record<string, unknown>): Promise<RunResult> {
  const result = await runRequest({ run_id: runId, input });
  return JSON.parse(JSON.stringify(result)) as RunResult;
}

const asOfField = (asOf: string | null | undefined) => (asOf ? { as_of: asOf } : {});

export async function runWeek(runId: string, asOf: string | null, question: string): Promise<RunResult> {
  return send(runId, { task: "explain_week", question, ...asOfField(asOf) });
}

export async function runTheses(runId: string, asOf: string | null): Promise<RunResult> {
  return send(runId, { task: "thesis_check", ...asOfField(asOf) });
}

export type PreTradeChoice =
  | { plan_id: string }
  | { trade: { symbol: string; side: "buy" | "sell"; quantity: number; price?: number } };

export async function runPreTrade(runId: string, asOf: string | null, choice: PreTradeChoice): Promise<RunResult> {
  return send(runId, { task: "pre_trade", ...asOfField(asOf), ...choice });
}

export async function sendCorrection(runId: string, reviewRunId: string, text: string, wrongMemoryIds: string[] = []): Promise<RunResult> {
  return send(runId, { task: "feedback", review_run_id: reviewRunId, text, wrong_memory_ids: wrongMemoryIds });
}
