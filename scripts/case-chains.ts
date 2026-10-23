// Which eval and end-to-end cases depend on each other, and how to run them N at a time. A chain is a list of case
// ids where a later case reads what an earlier one wrote to memory, so its cases always run in this order, one after
// the other, in one data dir. Different chains, and cases in no chain, may run at the same time.
import { runWithLimit, type Settled } from "../src/agent/concurrency";

/**
 * The chains, found in input_examples/ and evals/expectations.json:
 * - example_3b expects memory_recalled (expectations.json "example_3b"): the review example_3a stored for 2026-09-24
 *   is the latest review before its as_of 2026-10-01 (src/agent/memory.ts recallUnlocked).
 * - example_7a is feedback with review_run_id "example_3a" (input_examples/example_7a.json); learnCorrection refuses
 *   when no remembered review has that run id (src/agent/memory.ts learnCorrectionUnlocked), so it needs example_3a.
 * - example_7b expects memory_recalled_tag "correction" (expectations.json "example_7b"): the correction example_7a
 *   learned.
 * example_3b runs before example_7a, as in today's name order, so it never sees the correction.
 * No red-team case reads another case's memory: none has a memory expectation (evals/redteam/cases.json).
 */
export const CASE_CHAINS: ReadonlyArray<readonly string[]> = [["example_3a", "example_3b", "example_7a", "example_7b"]];

/**
 * Splits `ids` (in the usual case order) into groups to run: each chain's ids that are present form one group, in
 * chain order, placed where its first present id stands; every other id is a group of its own. Each id lands in
 * exactly one group. An id listed in two chains is an error, because it could not run in both orders.
 */
export function chainGroups(ids: readonly string[], chains: ReadonlyArray<readonly string[]> = CASE_CHAINS): string[][] {
  const chainOf = new Map<string, number>();
  chains.forEach((chain, index) => {
    for (const id of chain) {
      if (chainOf.has(id)) throw new Error(`Case ${id} is in two chains.`);
      chainOf.set(id, index);
    }
  });
  const present = new Set(ids);
  const placed = new Set<number>();
  const groups: string[][] = [];
  for (const id of ids) {
    const chain = chainOf.get(id);
    if (chain === undefined) {
      groups.push([id]);
    } else if (!placed.has(chain)) {
      placed.add(chain);
      groups.push(chains[chain].filter((member) => present.has(member)));
    }
  }
  return groups;
}

/**
 * Runs each group with `runGroup`, at most `concurrency` groups at once, through runWithLimit. A group's own cases run
 * in order inside `runGroup`. Resolves when every group has settled, one result per group in the groups' order.
 */
export function runChains<T>(groups: readonly string[][], runGroup: (group: string[], index: number) => Promise<T>, concurrency: number): Promise<Settled<T>[]> {
  return runWithLimit(
    groups.map((group, index) => () => runGroup(group, index)),
    concurrency,
  );
}

/**
 * The concurrency from `--concurrency N` or `--concurrency=N` in `argv`, else `envValue` (EVAL_CONCURRENCY), else 1.
 * Returns the remaining arguments too. A value that is not a whole number of at least 1 is an error.
 */
export function parseConcurrency(argv: readonly string[], envValue: string | undefined): { concurrency: number; rest: string[]; error: string | null } {
  const rest: string[] = [];
  let raw: string | undefined = envValue === undefined || envValue.trim() === "" ? undefined : envValue.trim();
  let from = "EVAL_CONCURRENCY";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--concurrency") {
      raw = argv[i + 1];
      from = "--concurrency";
      i += 1;
    } else if (arg.startsWith("--concurrency=")) {
      raw = arg.slice("--concurrency=".length);
      from = "--concurrency";
    } else {
      rest.push(arg);
    }
  }
  if (raw === undefined) return { concurrency: 1, rest, error: from === "--concurrency" ? "--concurrency needs a number." : null };
  if (!/^\d+$/.test(raw) || Number(raw) < 1) return { concurrency: 1, rest, error: `${from} must be a whole number of at least 1, got ${JSON.stringify(raw)}.` };
  return { concurrency: Number(raw), rest, error: null };
}
