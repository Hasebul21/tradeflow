// Revise, don't restart, in code: on rounds 2 and 3 the Analyst's new draft is merged with the previous one, so a
// finding that already passed the checks is never lost while the Analyst fixes another. A previous finding the
// Evaluator did not flag, that the new draft neither replaces (the same kind and subject) nor retracts, and that
// still passes the code checks on its own, is carried into the new draft. A finding the coverage check requires
// (requiredFindings in agents/evaluator.ts) that the new draft lacks is restored from the previous draft, even when
// the Analyst retracted it or the model's fix named it, as long as it passes the code checks. Pure: orchestrator.ts
// writes one trace line for each finding kept here.
import { meetsRequirement, type Requirement } from "./agents/evaluator";
import type { ResultStore, Task } from "./context";
import { afterModel, checkCitations, type Finding } from "./guards";
import type { RecalledMemory } from "./memory";

/** A previous finding the Analyst withdraws on purpose, by its kind and subject, with its reason. */
export type Retraction = { kind: string; subject: string; why: string };

/** A previous finding code put back: "carried" (the new draft left it out) or "restored" (coverage requires it). */
export type KeptFinding = { finding: Finding; /** Its number in the previous draft, counting from 1. */ was: number; how: "carried" | "restored"; why: string };

export type RevisionInput = {
  task: Task;
  /** The draft the Evaluator rejected last round. */
  previous: readonly Finding[];
  /** The previous findings the rejection flagged (by identity): never carried, only restored when coverage requires one. */
  flagged: ReadonlySet<Finding>;
  /** The Analyst's new findings. */
  next: readonly Finding[];
  retracted: readonly Retraction[];
  /** What the coverage check requires (requiredFindings). */
  required: readonly Requirement[];
  /** The run's result store and recalled memories, for the code checks. */
  store: ResultStore;
  memories?: readonly RecalledMemory[];
};

export type Revision = { findings: Finding[]; kept: KeptFinding[] };

const keyOf = (finding: { kind: string; subject: string }) => `${finding.kind}\u0000${finding.subject}`;

/** The checks the Evaluator's code runs, on one finding: its numbers are in its cited rows and the reply guard allows it. */
export function passesCodeChecks(finding: Finding, task: Task, store: ResultStore, memories: readonly RecalledMemory[] = []): boolean {
  return checkCitations([finding], store, memories).ok && afterModel("Analyst", { findings: [finding] }, { task }).ok;
}

/**
 * The new draft with the previous findings code keeps. A kept finding goes back at its previous position, so the
 * draft still leads with what mattered most; the new findings keep their own order around it.
 */
export function mergeRevision(input: RevisionInput): Revision {
  const { previous, flagged, next, required, task, store } = input;
  const memories = input.memories ?? [];
  const nextKeys = new Set(next.map(keyOf));
  const retractedKeys = new Set(input.retracted.map(keyOf));
  const passes = (finding: Finding) => passesCodeChecks(finding, task, store, memories);
  const kept = new Map<number, KeptFinding>();

  // 1. Carried: left out of the new draft without being replaced, retracted or flagged.
  for (const [index, finding] of previous.entries()) {
    if (nextKeys.has(keyOf(finding)) || retractedKeys.has(keyOf(finding)) || flagged.has(finding) || !passes(finding)) continue;
    kept.set(index, { finding, was: index + 1, how: "carried", why: "the Evaluator did not flag it and the new draft left it out without replacing or retracting it" });
  }

  // 2. Restored: each requirement the new draft does not meet gets the first previous finding that meets it and
  // passes the code checks. One that step 1 already carried is relabelled, so the trace says why it matters.
  for (const need of required) {
    if (next.some((finding) => meetsRequirement(finding, need))) continue;
    const already = [...kept.values()].find((entry) => meetsRequirement(entry.finding, need));
    if (already !== undefined) {
      if (already.how === "carried") kept.set(already.was - 1, { ...already, how: "restored", why: need.why });
      continue;
    }
    const index = previous.findIndex((finding) => meetsRequirement(finding, need) && passes(finding));
    if (index < 0) continue;
    const finding = previous[index];
    const despite = retractedKeys.has(keyOf(finding)) ? "; the Analyst retracted it, but a required finding is never dropped" : flagged.has(finding) ? "; the fix named it, but a required finding is never dropped" : "";
    kept.set(index, { finding, was: index + 1, how: "restored", why: `${need.why}${despite}` });
  }

  const findings = [...next];
  const entries = [...kept.values()].sort((a, b) => a.was - b.was);
  for (const entry of entries) findings.splice(Math.min(entry.was - 1, findings.length), 0, entry.finding);
  return { findings, kept: entries };
}

/** A finding code left out of the draft, with the gap the review shows for it. */
export type DroppedFinding = { finding: Finding; gap: string };

/**
 * A finding the last rejection flagged that comes back (the same kind and subject) still failing the code checks is
 * left out, with a gap that says so, instead of sinking the whole run. Never a finding the coverage check needs: one
 * that is the only finding meeting a requirement stays, and the Evaluator rejects the draft as before. The check
 * itself is unchanged; code only declines to repeat a finding whose figures no cited row holds.
 */
export function dropRepeatFailures(input: { task: Task; flagged: ReadonlySet<Finding>; findings: readonly Finding[]; required: readonly Requirement[]; store: ResultStore; memories?: readonly RecalledMemory[] }): {
  findings: Finding[];
  dropped: DroppedFinding[];
} {
  const flaggedKeys = new Set([...input.flagged].map(keyOf));
  let findings = [...input.findings];
  const dropped: DroppedFinding[] = [];
  for (const finding of input.findings) {
    if (!flaggedKeys.has(keyOf(finding)) || passesCodeChecks(finding, input.task, input.store, input.memories)) continue;
    const without = findings.filter((other) => other !== finding);
    const needed = input.required.some((need) => meetsRequirement(finding, need) && !without.some((other) => meetsRequirement(other, need)));
    if (needed) continue;
    findings = without;
    dropped.push({ finding, gap: `The ${finding.kind} finding on ${finding.subject} was left out: after the Evaluator's fix it still used figures that no cited row of this run holds.` });
  }
  return { findings, dropped };
}
