// Pure helpers for the trace viewer and the review queue: one trace line becomes one timeline step with the fields a
// judge reads (agent, action, status, retry, why, confidence, model, query source, usage), and the agent's own detail:
// a Planner step's why, an Evaluator step's scores, a Query step's source, a Memory step's retrievalReason.
import { STOP_REASON_LABELS, STOP_REASONS, type StopReasonCode } from "@/agent/labels";
import type { TraceLine } from "@/agent/trace";
import type { RunSummary } from "@/agent/trace-read";

export type StepRow = {
  n: number;
  agent: string;
  action: string;
  status: string;
  retry: number;
  why: string | null;
  confidence: number | null;
  model: string | null;
  source: string | null;
  usage: string | null;
  /** What the agent's step proves, in the agent's own words; null when the step has nothing more to say. */
  detail: { label: string; text: string } | null;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** "2 model calls, 310 in / 95 out tokens", or null when the line carries no usage. */
export function usageText(usage: TraceLine["usage"]): string | null {
  if (usage === undefined || usage === null) return null;
  const parts: string[] = [];
  if (usage.model_calls !== undefined) parts.push(`${usage.model_calls} model ${usage.model_calls === 1 ? "call" : "calls"}`);
  if (usage.query_calls !== undefined) parts.push(`${usage.query_calls} query ${usage.query_calls === 1 ? "call" : "calls"}`);
  if (usage.tokens_in !== undefined || usage.tokens_out !== undefined) parts.push(`${usage.tokens_in ?? 0} in / ${usage.tokens_out ?? 0} out tokens`);
  return parts.length === 0 ? null : parts.join(", ");
}

function detailOf(line: TraceLine): StepRow["detail"] {
  switch (line.agent_name) {
    case "Planner":
      return text(line.why) === null ? null : { label: "Why this query", text: line.why as string };
    case "Evaluator":
      return text(line.output_summary) === null ? null : { label: "Scores", text: line.output_summary };
    case "Query":
      return line.source === undefined ? null : { label: "Source", text: line.source };
    case "Memory":
      return text(line.retrievalReason) === null ? null : { label: "Retrieval reason", text: line.retrievalReason as string };
    default:
      return null;
  }
}

/** Every line as a step, in file order, numbered from 1. */
export function stepRows(lines: readonly TraceLine[]): StepRow[] {
  return lines.map((line, index) => ({
    n: index + 1,
    agent: line.agent_name,
    action: line.action,
    status: line.status,
    retry: typeof line.retry_count === "number" ? line.retry_count : 0,
    why: text(line.why),
    confidence: typeof line.confidence === "number" ? line.confidence : null,
    model: text(line.model),
    source: text(line.source),
    usage: usageText(line.usage),
    detail: detailOf(line),
  }));
}

const isStopCode = (code: string): code is StopReasonCode => (STOP_REASONS as readonly string[]).includes(code);

/** Why a needs_human run waits: its stop reason in plain words, its escalation rule, or the fallback sentence. */
export function waitingFor(run: Pick<RunSummary, "stop_reason" | "escalation_rule">): string {
  if (run.stop_reason !== null) return isStopCode(run.stop_reason) ? STOP_REASON_LABELS[run.stop_reason] : `The run stopped: ${run.stop_reason}.`;
  if (run.escalation_rule === "reconcile_proposals") return "The reconciliation proposes fixes; none is applied until you approve it.";
  if (run.escalation_rule !== null) return `The trade would newly break the rule ${run.escalation_rule}. Nothing has been saved; the decision is yours.`;
  return "The run waits for your decision.";
}
