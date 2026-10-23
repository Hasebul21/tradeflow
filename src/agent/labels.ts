// Words shared by the run result and the Explain page. No imports, so a client component can use them.

/** Opens the summary and the review of a run that ended model_unavailable; the Explain page shows the same words. */
export const MODEL_UNAVAILABLE_LABEL = "Draft built by code: the model was unavailable after the queries ran";

/** Every code a run can stop with when it ends needs_human. orchestrator.ts builds StopReason from this list, so a new code is added here first. */
export const STOP_REASONS = ["rounds", "query_calls", "model_calls", "tokens", "round_timeout", "run_timeout", "writer_rejected", "model_unavailable", "cancelled"] as const;
export type StopReasonCode = (typeof STOP_REASONS)[number];

/** One plain sentence per stop code, for the Explain page. A new code without a sentence fails the type check and the labels test. */
export const STOP_REASON_LABELS: Record<StopReasonCode, string> = {
  rounds: "The draft was not accepted within the round limit. The findings are the best draft, unreviewed.",
  query_calls: "The run used up its query budget before the draft was accepted.",
  model_calls: "The run used up its model-call budget before the draft was accepted.",
  tokens: "The run used up its token budget before the draft was accepted.",
  round_timeout: "A round took longer than its time limit, so the run stopped.",
  run_timeout: "The run took longer than its time limit, so it stopped.",
  writer_rejected: "The written review failed its checks twice, so the run stopped.",
  model_unavailable: MODEL_UNAVAILABLE_LABEL,
  cancelled: "You stopped the run. The findings are the best draft so far, unreviewed.",
};
