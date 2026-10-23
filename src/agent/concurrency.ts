// Two small primitives for work that overlaps inside one process: a cap on how many jobs run at once (the briefing's
// children, MAX_CONCURRENT_CHILDREN) and a FIFO lock per key (one memory or World Model store per data dir).

/** What runWithLimit returns for each job, in the jobs' order. */
export type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

/**
 * Runs `jobs` with at most `limit` in flight. When one settles the next waiting job starts. Resolves when every job
 * has settled, with one result per job in the jobs' order; never throws, a rejection (or a job that throws) becomes
 * { status: "rejected", reason }. A limit below 1 or not a whole number counts as 1.
 */
export async function runWithLimit<T>(jobs: ReadonlyArray<() => Promise<T>>, limit: number): Promise<Settled<T>[]> {
  const results: Settled<T>[] = new Array(jobs.length);
  const width = Math.min(jobs.length, Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await jobs[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier call with the same `key` has settled, so calls for one key run one at a time in the
 * order they were made. A failure in one call does not block the next. Do not call withLock with the same key from
 * inside `fn`: it would wait for itself.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
