// Pure: turns one run's trace lines into the counts the Explain page's Proof cards show. It counts only what the
// lines say (agent_name, action, status, source, model, usage, output_summary) and invents no number.

export type ProofLine = {
  agent_name?: unknown;
  action?: unknown;
  status?: unknown;
  source?: unknown;
  model?: unknown;
  fallback?: unknown;
  confidence?: unknown;
  why?: unknown;
  output_summary?: unknown;
  usage?: { tokens_in?: unknown; tokens_out?: unknown; model_calls?: unknown } | null;
};

export type Proof = {
  zetaris: { queries: number; via_zetaris: number; local: number; fallback: number };
  meterless: { memories_recalled: number; taken_by_tag: number; corrections_applied: number; world_facts_written: number };
  nemotron: { models: { model_id: string; calls: number }[]; tokens_in: number; tokens_out: number; strong_to_main_fallbacks: number };
  guards: { checked: number; blocked: number; injections_flagged: number; advice_declined: number };
  loop: { rounds: number; rejected_rounds: number; final_score_out_of_9: number };
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** "by_tag=mem-1,mem-2; by_query=none" gives 2 for "by_tag"; "none" and a missing key give 0. */
function idCount(summary: string, key: string): number {
  const match = new RegExp(`${key}=([^;]*)`).exec(summary);
  const value = match?.[1].trim() ?? "none";
  return value === "" || value === "none" ? 0 : value.split(",").filter((id) => id.trim() !== "").length;
}

export function proofFromTrace(lines: readonly ProofLine[]): Proof {
  const proof: Proof = {
    zetaris: { queries: 0, via_zetaris: 0, local: 0, fallback: 0 },
    meterless: { memories_recalled: 0, taken_by_tag: 0, corrections_applied: 0, world_facts_written: 0 },
    nemotron: { models: [], tokens_in: 0, tokens_out: 0, strong_to_main_fallbacks: 0 },
    guards: { checked: 0, blocked: 0, injections_flagged: 0, advice_declined: 0 },
    loop: { rounds: 0, rejected_rounds: 0, final_score_out_of_9: 0 },
  };
  const calls = new Map<string, number>();
  for (const line of lines) {
    const agent = text(line.agent_name);
    const action = text(line.action);
    const summary = text(line.output_summary);
    if (agent === "Query" && action === "query") {
      proof.zetaris.queries += 1;
      if (line.source === "zetaris") proof.zetaris.via_zetaris += 1;
      else if (line.source === "local") proof.zetaris.local += 1;
      else if (line.source === "local-fallback") proof.zetaris.fallback += 1;
    } else if (agent === "Memory" && action === "recall") {
      const byTag = idCount(summary, "by_tag");
      proof.meterless.taken_by_tag += byTag;
      proof.meterless.memories_recalled += byTag + idCount(summary, "by_query");
      proof.meterless.corrections_applied += idCount(summary, "corrections");
    } else if (agent === "World" && action === "record") {
      const facts = /facts=(\d+)/.exec(summary);
      proof.meterless.world_facts_written += facts === null ? 0 : Number(facts[1]);
    } else if (action === "model_call") {
      const model = typeof line.model === "string" && line.model !== "" ? line.model : null;
      if (model !== null) calls.set(model, (calls.get(model) ?? 0) + 1);
      proof.nemotron.tokens_in += num(line.usage?.tokens_in);
      proof.nemotron.tokens_out += num(line.usage?.tokens_out);
      if (line.fallback === "strong->main") proof.nemotron.strong_to_main_fallbacks += 1;
    } else if (agent === "Guard") {
      if (action === "allow" || action === "block") proof.guards.checked += 1;
      if (action === "block") proof.guards.blocked += 1;
      if (action === "injection_flagged") proof.guards.injections_flagged += 1;
      if (action === "advice_declined") proof.guards.advice_declined += 1;
    } else if (agent === "Evaluator" && (action === "accept" || action === "reject")) {
      proof.loop.rounds += 1;
      if (action === "reject") proof.loop.rejected_rounds += 1;
      proof.loop.final_score_out_of_9 = Math.round(num(line.confidence) * 9);
    }
  }
  proof.nemotron.models = [...calls].map(([model_id, n]) => ({ model_id, calls: n }));
  return proof;
}
