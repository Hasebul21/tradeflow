// Pure helpers for the Explain page's badges and banner. Each one reads the run's output or trace lines only.
import { MODEL_UNAVAILABLE_LABEL, STOP_REASON_LABELS, type StopReasonCode } from "@/agent/labels";
import type { RunResult } from "@/agent/orchestrator";

type Line = { agent_name?: unknown; action?: unknown; why?: unknown; output_summary?: unknown };
type Output = NonNullable<RunResult["output"]>;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-24" as "Thu 24 Sep". */
export function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** The green badge for a declined question, or null. */
export function adviceBadge(output: Pick<Output, "declined_advice"> | null | undefined): string | null {
  return output?.declined_advice === true ? "Advice declined" : null;
}

/** The Guard's "as_of moved from X to Y" line as "Moved to Thu 24 Sep", or null when the date did not move. */
export function movedBadge(lines: readonly Line[]): string | null {
  for (const line of lines) {
    if (line.agent_name !== "Guard" || line.action !== "as_of_moved") continue;
    const match = /as_of moved from \S+ to (\d{4}-\d{2}-\d{2})/.exec(typeof line.output_summary === "string" ? line.output_summary : "");
    if (match) return `Moved to ${shortDate(match[1])}`;
  }
  return null;
}

/** The badge for a question the data does not cover, read from the run's gaps, or null. */
export function outOfScopeBadge(output: Pick<Output, "gaps"> | null | undefined): string | null {
  return (output?.gaps ?? []).some((gap) => /asks for nothing the portfolio data covers/.test(gap)) ? "Out of scope: listed under what I could not cover" : null;
}

/** True when the Evaluator accepted the draft on the code checks alone because the model returned no score. */
export function scoreUnavailable(lines: readonly Line[]): boolean {
  return lines.some((line) => line.agent_name === "Evaluator" && line.action === "score_unavailable");
}

/** The Scores cell: the three scores and the total, "score unavailable" (never 0) when the model gave none, or "not scored". */
export function scoresText(output: Pick<Output, "scores"> | null | undefined, lines: readonly Line[]): string {
  const s = output?.scores;
  if (s) return `accuracy ${s.accuracy}, appropriateness ${s.appropriateness}, actionability ${s.actionability}, total ${s.total} of 9`;
  return scoreUnavailable(lines) ? "score unavailable: the model returned no answer; the code checks passed" : "not scored";
}

/** The banner under the result header when more than one round ran, or null. The reason is the Evaluator's first rejection. */
export function selfCorrectionBanner(output: Pick<Output, "rounds" | "scores"> | null | undefined, lines: readonly Line[]): string | null {
  if (output === null || output === undefined || output.rounds <= 1) return null;
  const reject = lines.find((line) => line.agent_name === "Evaluator" && line.action === "reject");
  const reason = typeof reject?.why === "string" && reject.why !== "" ? reject.why : "the Evaluator asked for a fix";
  const score = output.scores ? `, score ${output.scores.total}/9` : scoreUnavailable(lines) ? ", score unavailable" : "";
  return `Draft 1 rejected: ${reason}. Draft ${output.rounds} accepted${score}.`;
}

/** The purple chip for a run that recalled an owner correction, or null. */
export function correctionChip(output: Pick<Output, "applied_corrections"> | null | undefined): string | null {
  return (output?.applied_corrections.length ?? 0) > 0 ? "Applied your correction" : null;
}

/** The label for a draft the code built because the model failed after the queries ran, or null. It is never shown as a model answer. */
export function modelUnavailableLabel(output: Pick<Output, "stop_reason"> | null | undefined): string | null {
  return output?.stop_reason === "model_unavailable" ? MODEL_UNAVAILABLE_LABEL : null;
}

/** The sentence for a stop code, or null when the run has none (an escalation has stop_reason null). */
export function stopReasonLabel(output: Pick<Output, "stop_reason"> | null | undefined): string | null {
  const code = output?.stop_reason;
  return code ? (STOP_REASON_LABELS as Record<string, string>)[code as StopReasonCode] ?? null : null;
}

/** The header cell for the round: "accepted in round N" only for success; needs_human gives the stop sentence, never "accepted". */
export function acceptedText(status: RunResult["status"], output: Pick<Output, "rounds" | "stop_reason"> | null | undefined): string {
  if (status === "success") return `accepted in round ${output?.rounds ?? 0}`;
  return stopReasonLabel(output) ?? "Not accepted. The decision is yours.";
}
