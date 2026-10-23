// Revise, don't restart, in code: on rounds 2 and 3 the Analyst's new draft is merged with the previous one, so a
// finding that already passed the checks is never lost while the Analyst fixes another. A previous finding the
// Evaluator did not flag, that the new draft neither replaces (the same kind and subject) nor retracts, and that
// still passes the code checks on its own, is carried into the new draft. A finding the coverage check requires
// (requiredFindings in agents/evaluator.ts) that the new draft lacks is restored from the previous draft, even when
// the Analyst retracted it (with a gap code writes, so the review says so), as long as it passes the code checks. One
// the last fix flagged is not restored unchanged: the coverage check asks for it again. Pure: orchestrator.ts writes
// one trace line for each finding kept here and keeps the gaps for the rest of the run.
import { FINDING_KINDS } from "./agents/analyst";
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
  /** The run's as_of, so a run-dated day range in a claim (11-17 Sept 2026) reads as dates, as the Evaluator reads it. */
  asOf?: string;
  /** knownSubjects plus the required subjects: the only subjects a gap written here may name. */
  known?: ReadonlySet<string>;
};

/** A gap code wrote about a finding, with the finding it is about, so the run can keep it while it stays true. */
export type CodeNote = {
  key: string;
  gap: string;
  /** The finding the note is about; a restore note holds while this exact finding is in the draft. */
  finding: Finding;
  kind: "dropped" | "kept_despite_retraction";
  /** A drop note: the findings with the same kind and subject that passed the code checks when it was dropped. */
  survivors?: number;
};

export type Revision = { findings: Finding[]; kept: KeptFinding[]; notes: CodeNote[] };

export const keyOf = (finding: { kind: string; subject: string }) => `${finding.kind}\u0000${finding.subject}`;

/** The code check one finding fails on its own, in the Evaluator's order, or null when it passes both. */
export function failingCheck(finding: Finding, task: Task, store: ResultStore, memories: readonly RecalledMemory[] = [], asOf?: string): "citations" | "guard" | null {
  if (!checkCitations([finding], store, memories, undefined, asOf).ok) return "citations";
  return afterModel("Analyst", { findings: [finding] }, { task }).ok ? null : "guard";
}

/** The checks the Evaluator's code runs, on one finding: its numbers are in its cited rows and the reply guard allows it. */
export function passesCodeChecks(finding: Finding, task: Task, store: ResultStore, memories: readonly RecalledMemory[] = [], asOf?: string): boolean {
  return failingCheck(finding, task, store, memories, asOf) === null;
}

const isKind = (kind: string) => (FINDING_KINDS as readonly string[]).includes(kind);

/** "The <kind> finding on <subject>" when both are validated names, else "A flagged finding" (see droppedGap). */
function named(finding: Finding, known: ReadonlySet<string>, fallback: string): string {
  return isKind(finding.kind) && known.has(finding.subject) ? `The ${finding.kind} finding on ${finding.subject}` : fallback;
}

/**
 * The code-written gap for a required finding kept although the Analyst withdrew it. The Analyst's reason is model
 * text, so it stays in the trace line and out of this trusted gap; the subject is named only when validated.
 */
export function keptDespiteRetractionGap(finding: Finding, known: ReadonlySet<string>): string {
  const what = isKind(finding.kind) && known.has(finding.subject) ? `its ${finding.kind} finding on ${finding.subject}` : "a finding";
  return `The Analyst withdrew ${what}; it is kept unchanged because the coverage check requires it.`;
}

/**
 * The new draft with the previous findings code keeps. A kept finding goes back at its previous position, so the
 * draft still leads with what mattered most; the new findings keep their own order around it.
 */
export function mergeRevision(input: RevisionInput): Revision {
  const { previous, flagged, next, required, task, store } = input;
  const memories = input.memories ?? [];
  const known = input.known ?? new Set<string>();
  const retractedKeys = new Set(input.retracted.map(keyOf));
  const passes = (finding: Finding) => passesCodeChecks(finding, task, store, memories, input.asOf);
  const kept = new Map<number, KeptFinding>();
  // A new finding replaces one previous finding with the same kind and subject: matched by count, so when the
  // previous draft had two and the new one has one, one is left over and may be carried. A flagged one is replaced
  // first, because the new finding is most likely its fix; then the rest in draft order.
  const replacing = new Map<string, number>();
  for (const finding of next) replacing.set(keyOf(finding), (replacing.get(keyOf(finding)) ?? 0) + 1);
  const replaced = new Set<number>();
  const order = [...previous.keys()].sort((a, b) => Number(flagged.has(previous[b])) - Number(flagged.has(previous[a])) || a - b);
  for (const index of order) {
    const key = keyOf(previous[index]);
    const left = replacing.get(key) ?? 0;
    if (left === 0) continue;
    replacing.set(key, left - 1);
    replaced.add(index);
  }

  // 1. Carried: left out of the new draft without being replaced, retracted or flagged.
  for (const [index, finding] of previous.entries()) {
    const key = keyOf(finding);
    if (replaced.has(index) || retractedKeys.has(key) || flagged.has(finding) || !passes(finding)) continue;
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
    // One the last fix flagged is not put back unchanged: the coverage check rejects the draft and asks for it again,
    // so the Analyst writes it anew instead of the Evaluator seeing the version it already refused.
    const index = previous.findIndex((finding) => meetsRequirement(finding, need) && !flagged.has(finding) && passes(finding));
    if (index < 0) continue;
    const finding = previous[index];
    const despite = retractedKeys.has(keyOf(finding)) ? "; the Analyst retracted it, but a required finding is never dropped" : "";
    kept.set(index, { finding, was: index + 1, how: "restored", why: `${need.why}${despite}` });
  }

  const findings = [...next];
  const entries = [...kept.values()].sort((a, b) => a.was - b.was);
  for (const entry of entries) findings.splice(Math.min(entry.was - 1, findings.length), 0, entry.finding);
  const notes: CodeNote[] = entries
    .filter((entry) => entry.how === "restored" && retractedKeys.has(keyOf(entry.finding)))
    .map((entry) => ({ key: keyOf(entry.finding), gap: keptDespiteRetractionGap(entry.finding, known), finding: entry.finding, kind: "kept_despite_retraction" }));
  return { findings, kept: entries, notes };
}

/**
 * A finding code left out of the draft, with the gap the review shows for it: `unnamed` when the gap could not name
 * it, and `survivors`, the findings with its kind and subject left in the draft that pass the code checks.
 */
export type DroppedFinding = { finding: Finding; gap: string; unnamed: boolean; survivors: number };

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/**
 * The names a gap written by code may hold: the data's instrument symbols and sector names, and every sector a row of
 * this run gives. A gap code writes is trusted (the Writer may repeat its figures), so it never carries model text.
 */
export function knownSubjects(instruments: Iterable<{ symbol: string; sector: string }>, store: ResultStore): Set<string> {
  const known = new Set<string>();
  for (const instrument of instruments) {
    known.add(instrument.symbol);
    known.add(instrument.sector);
  }
  for (const result of Object.values(store)) for (const row of result.rows) if (typeof row.sector === "string") known.add(row.sector);
  known.delete("");
  return known;
}

/**
 * The code-written gap for a dropped finding. It names the kind and the subject only when each is a validated
 * identifier (one of the nine kinds; a known symbol or sector, exactly): finding.kind and finding.subject are model
 * text, and a subject such as "BXPHARMA 99.9" would otherwise put 99.9 among the figures the Writer may repeat.
 */
export function droppedGap(finding: Finding, known: ReadonlySet<string>, check: "citations" | "guard" = "citations", ordinal = 1): string {
  // An unnamed drop gets an ordinal word, never a digit (a digit would be a figure the Writer may repeat), so two
  // drops show as two gaps.
  const which = ORDINALS[ordinal - 1] ?? "next";
  return `${named(finding, known, `A flagged finding (the ${which} one code left out)`)} ${DROPPED_GAP_MARK} after the Evaluator's fix ${dropReason(check)}.`;
}

const dropReason = (check: "citations" | "guard") => (check === "citations" ? "it still used figures that no cited row of this run holds" : "the reply guard still refused it (advice, or a finding that breaks the schema)");

/** Whether a gap is one droppedGap wrote, exactly: eval-checks.ts fails a run that has one. */
export function isDroppedGap(gap: string): boolean {
  const tail = (["citations", "guard"] as const).map((check) => ` ${DROPPED_GAP_MARK} after the Evaluator's fix ${dropReason(check)}.`);
  const end = tail.find((text) => gap.endsWith(text));
  if (end === undefined) return false;
  const head = gap.slice(0, -end.length);
  return /^The [a-z_]+ finding on .+$/.test(head) || /^A flagged finding \(the [a-z]+ one code left out\)$/.test(head);
}

/** The words every dropped-finding gap holds; eval-checks.ts finds a drop by them. */
export const DROPPED_GAP_MARK = "was left out:";

/**
 * A finding the last rejection flagged that comes back (the same kind and subject) still failing the code checks is
 * left out, with a gap that says so, instead of sinking the whole run. Never a finding the coverage check needs: one
 * that is the only finding meeting a requirement stays, and the Evaluator rejects the draft as before. The check
 * itself is unchanged; code only declines to repeat a finding whose figures no cited row holds.
 */
export function dropRepeatFailures(input: {
  task: Task;
  flagged: ReadonlySet<Finding>;
  findings: readonly Finding[];
  required: readonly Requirement[];
  store: ResultStore;
  /** knownSubjects: the only subjects the gap may name. */
  known: ReadonlySet<string>;
  memories?: readonly RecalledMemory[];
  /** The run's as_of, as for mergeRevision. */
  asOf?: string;
  /** The ordinal the first unnamed drop's gap gets (the run's earlier unnamed drops plus one). */
  firstOrdinal?: number;
}): {
  findings: Finding[];
  dropped: DroppedFinding[];
} {
  const flaggedKeys = new Set([...input.flagged].map(keyOf));
  let findings = [...input.findings];
  const dropped: DroppedFinding[] = [];
  for (const finding of input.findings) {
    if (!flaggedKeys.has(keyOf(finding))) continue;
    const check = failingCheck(finding, input.task, input.store, input.memories, input.asOf);
    if (check === null) continue;
    const without = findings.filter((other) => other !== finding);
    const needed = input.required.some((need) => meetsRequirement(finding, need) && !without.some((other) => meetsRequirement(other, need)));
    if (needed) continue;
    findings = without;
    const unnamed = !(isKind(finding.kind) && input.known.has(finding.subject));
    const ordinal = (input.firstOrdinal ?? 1) + dropped.filter((gone) => gone.unnamed).length;
    dropped.push({ finding, gap: droppedGap(finding, input.known, check, ordinal), unnamed, survivors: 0 });
  }
  // Survivors are counted on the final draft, so a later drop of the same key counts too.
  for (const gone of dropped) gone.survivors = findings.filter((other) => keyOf(other) === keyOf(gone.finding) && passesCodeChecks(other, input.task, input.store, input.memories, input.asOf)).length;
  return { findings, dropped };
}
