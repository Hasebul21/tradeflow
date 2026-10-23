// The tool policy: who may run which named query for which task, and who may write which kind of memory. Two pure
// functions over one table, no I/O and no trace line; guards.beforeQuery and guards.beforeRemember call them and
// write the "policy_denied" Guard line. The model never decides what it may call: code asks here (AGENTS.md rule 6).
import { catalogueFor, TASKS, type Task } from "./context";

export type QueryCaller = "Orchestrator" | "Analyst" | "Planner" | "Evaluator" | "Writer" | "Router";
export type MemoryKind = "review" | "correction" | "decision";
export type PolicyResult = { ok: true; reason: string } | { ok: false; reason: string };

/**
 * The table. `queries` says what each caller may run: the Analyst the task's catalogue, the Orchestrator (code) the
 * catalogue plus its `extra` queries for the tasks named there, and the model agents that never run a query nothing.
 * `fixed_chain` defines the catalogue of a task context.catalogueFor has no entry for, from that task's fixed chain.
 * `memory` says which kinds each caller may write: a model agent never writes a correction or a decision.
 */
export const POLICY = {
  queries: {
    Analyst: { catalogue: true, extra: {} },
    Orchestrator: { catalogue: true, extra: { pre_trade: ["what_if"], reconcile: ["reconciliation"], reconcile_approve: ["reconciliation"] } },
    Planner: { catalogue: false, extra: {} },
    Evaluator: { catalogue: false, extra: {} },
    Writer: { catalogue: false, extra: {} },
    Router: { catalogue: false, extra: {} },
  } as Record<string, { catalogue: boolean; extra: Record<string, readonly string[]> }>,
  fixed_chain: { reconcile_approve: ["reconciliation"] } as Record<string, readonly string[]>,
  memory: {
    Writer: ["review"],
    feedback: ["correction"],
    reconcile_approve: ["decision"],
  } as Record<string, readonly MemoryKind[]>,
} as const;

const isTask = (task: string): task is Task => (TASKS as readonly string[]).includes(task);

/** The queries a task's catalogue holds: catalogueFor for the four loop tasks, the fixed chain for the others, else none. */
function catalogueIds(task: string): readonly string[] {
  if (isTask(task)) return catalogueFor(task).map((entry) => entry.id);
  return Object.prototype.hasOwnProperty.call(POLICY.fixed_chain, task) ? POLICY.fixed_chain[task] : [];
}

/** Says whether `caller` may run `query_id` for `task`. The reason names the caller, the task and the query. */
export function allowedQuery(a: { caller: string; task: string; query_id: string }): PolicyResult {
  const { caller, task, query_id } = a;
  const rule = Object.prototype.hasOwnProperty.call(POLICY.queries, caller) ? POLICY.queries[caller] : undefined;
  const permitted = rule === undefined ? [] : [...(rule.catalogue ? catalogueIds(task) : []), ...(Object.prototype.hasOwnProperty.call(rule.extra, task) ? rule.extra[task] : [])];
  if (permitted.includes(query_id)) return { ok: true, reason: `policy: ${caller} may run ${query_id} for ${task}` };
  return { ok: false, reason: `policy: ${caller} may not run ${query_id} for ${task}` };
}

/** Says whether `caller` may write a memory of `kind`. The reason names the caller and the kind. */
export function allowedMemoryWrite(a: { caller: string; kind: string }): PolicyResult {
  const { caller, kind } = a;
  const kinds = Object.prototype.hasOwnProperty.call(POLICY.memory, caller) ? POLICY.memory[caller] : [];
  if ((kinds as readonly string[]).includes(kind)) return { ok: true, reason: `policy: ${caller} may write a ${kind} memory` };
  return { ok: false, reason: `policy: ${caller} may not write a ${kind} memory` };
}
