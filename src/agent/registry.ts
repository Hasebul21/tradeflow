// The registry of running runs: one AbortController per run, so the owner can stop a run and the server can cap how
// many top-level runs it takes at once. It lives on globalThis, so Next.js route handlers, server actions and a dev
// reload all see the same map. An entry holds the run id, the task, the parent run id and the start time, never the
// input text or a setting from .env. Server only: it is plain memory, but every caller is a route or the loop.

/** One running run as active() lists it. */
export type ActiveRun = { run_id: string; task: string; parent_run_id: string | null; started_at: string; elapsed_ms: number };

type Entry = { controller: AbortController; task: string; parent_run_id: string | null; started_at: string; started_ms: number };

const KEY = Symbol.for("tradeflow.run-registry");
type Holder = { [KEY]?: Map<string, Entry> };

function entries(): Map<string, Entry> {
  const holder = globalThis as unknown as Holder;
  holder[KEY] ??= new Map();
  return holder[KEY];
}

/** Adds a run and returns its signal. A run id that is already running is replaced; release(run_id, signal) then leaves the newer entry alone. */
export function register(run: { run_id: string; task: string; parent_run_id?: string | null }): AbortSignal {
  const controller = new AbortController();
  const started_ms = Date.now();
  entries().set(run.run_id, { controller, task: run.task, parent_run_id: run.parent_run_id ?? null, started_at: new Date(started_ms).toISOString(), started_ms });
  return controller.signal;
}

/** Removes a run. With the signal register() returned, it removes the entry only while that run still owns the id. */
export function release(run_id: string, signal?: AbortSignal): void {
  const map = entries();
  const entry = map.get(run_id);
  if (entry === undefined) return;
  if (signal !== undefined && entry.controller.signal !== signal) return;
  map.delete(run_id);
}

/** Aborts a running run: true when the id is running, false when it is not. */
export function cancel(run_id: string): boolean {
  const entry = entries().get(run_id);
  if (entry === undefined) return false;
  entry.controller.abort();
  return true;
}

/** Every running run, oldest first. */
export function active(): ActiveRun[] {
  const now = Date.now();
  return [...entries()]
    .map(([run_id, entry]) => ({ run_id, task: entry.task, parent_run_id: entry.parent_run_id, started_at: entry.started_at, elapsed_ms: now - entry.started_ms }))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** The running runs that no briefing started: the ones MAX_CONCURRENT_RUNS counts. */
export function topLevelCount(): number {
  let count = 0;
  for (const entry of entries().values()) if (entry.parent_run_id === null) count += 1;
  return count;
}
