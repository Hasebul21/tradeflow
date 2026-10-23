// Plain words for the codes the agent pages show: task names, the model, run ids, statuses and errors.
import { shortDate } from "@/components/format";

/** Each task by the name of its Explain tab. */
export const TASK_NAMES: Record<string, string> = {
  explain_week: "My week",
  thesis_check: "Theses",
  pre_trade: "Pre-trade",
  reconcile: "Reconcile",
  reconcile_approve: "Approve a fix",
  feedback: "Correction",
  briefing: "Weekly briefing",
};

/** The tab name of a task, the code itself for a task without one, or "-". */
export function taskName(task: string | null | undefined): string {
  if (!task) return "-";
  return TASK_NAMES[task] ?? task;
}

/** The Model cell: the sample model, no model, or the real model's ids. */
export function modelText(source: string): string {
  if (source === "sample-model") return "Sample model (offline)";
  if (source === "" || source.startsWith("none")) return "No model: code only";
  return `${source} (real model)`;
}

/** The first 8 characters of a run id; the full id goes in a tooltip. */
export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

/** What a run's status means, for the tooltip on its tag. */
export function statusHint(status: string): string {
  if (status === "success") return "The review passed its checks.";
  if (status === "needs_human") return "The run stopped and waits for your decision.";
  if (status === "error") return "The run could not finish.";
  return "The run is still working.";
}

/** The badge for citations that fell back to local data, or null when none did. */
export function fallbackText(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "citation" : "citations"} fell back to local data`;
}

export const ERROR_TITLE = "The run could not finish";

/** What to do after an error: retry when the error is recoverable, else change the inputs. */
export function errorAdvice(recoverable: boolean | undefined): string {
  return recoverable ? "Press the button again to retry. If it fails again, open Details." : "Change the inputs above and try again.";
}

/** The help under every As of picker on the Explain page. */
export function asOfHelp(range: { first: string; last: string }): string {
  return `The day whose closing prices are used, from ${shortDate(range.first)} to ${shortDate(range.last)}. Fridays and Saturdays, the exchange's weekend, are greyed out.`;
}

export const STEPS_HELP =
  "Each step is one agent action. The Planner picks queries, the Analyst reads the rows, the Evaluator scores the draft out of 9 (confidence is that score as a fraction), the Writer writes the review, and the Guard checks each step.";

export const CITATION_HELP = "Click a [name] to see the query and rows behind a number";

export const PROOF_HELP = "What this run used: data queries, memories, model calls and safety checks.";

/** The tooltip on each Proof card's name, by card key. */
export const PROOF_HINTS: Record<string, string> = {
  zetaris: "Queries that read your data. Via Zetaris: the SQL engine ran it. Local: the same function ran in the app.",
  meterless: "Notes and corrections from earlier reviews that this run recalled.",
  nemotron: "Calls to the language model, with tokens sent and received.",
  guards: "Checks on every query, model reply and memory write. Blocked: refused.",
};
