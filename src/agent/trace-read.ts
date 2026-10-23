// Reads runs back from logs/trace-<run_id>.jsonl for GET /run/<run_id>, GET /run/<run_id>/proof, the trace viewer
// (/explain/runs/<run_id>) and the review queue (/explain/queue). One reader, so every page checks the run id the same
// way, before any file read, and parses a trace the same way. Read only: it never writes. Server only (node:fs).
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { RUN_ID_PATTERN } from "./orchestrator";
import type { TraceLine } from "./trace";

export const RUN_ID_MESSAGE = "run_id must match /^[A-Za-z0-9_-]{1,80}$/.";

/** The logs directory of the running process; a caller passes its own only in a test. */
export const logsDir = (): string => path.resolve(process.cwd(), "logs");

export type TraceRead =
  | { ok: true; lines: TraceLine[] }
  | { ok: false; status: 400 | 404 | 500; type: "InvalidInput" | "NotFound" | "Internal"; message: string };

type Reader = (file: string, encoding: "utf8") => Promise<string>;

/** The lines of a trace file in file order. A line that does not parse (one still being written) is skipped. */
export function parseTrace(text: string): TraceLine[] {
  const lines: TraceLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as TraceLine);
    } catch {
      // A line that is still being written is skipped; the next read has it.
    }
  }
  return lines;
}

/** The run is over when the last line is the Orchestrator's run_end line or has a status of error. */
export function isDone(lines: readonly Pick<TraceLine, "agent_name" | "action" | "status">[]): boolean {
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  return (last.agent_name === "Orchestrator" && last.action === "run_end") || last.status === "error";
}

/**
 * The trace of one run. The run id is checked against RUN_ID_PATTERN before any file is read, so "../etc" never
 * reaches the file system. `read` is for tests: it stands in for fs.readFile.
 */
export async function readTrace(runId: string, options: { dir?: string; read?: Reader } = {}): Promise<TraceRead> {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return { ok: false, status: 400, type: "InvalidInput", message: RUN_ID_MESSAGE };
  const read = options.read ?? readFile;
  let text: string;
  try {
    text = await read(path.join(options.dir ?? logsDir(), `trace-${runId}.jsonl`), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, status: 404, type: "NotFound", message: `No trace for run ${runId}.` };
    return { ok: false, status: 500, type: "Internal", message: "The trace could not be read." };
  }
  return { ok: true, lines: parseTrace(text) };
}

export type RunStatusLabel = "success" | "needs_human" | "error" | "running";

/** One run as the review queue lists it, read from its run_end line. */
export type RunSummary = {
  run_id: string;
  task: string | null;
  as_of: string | null;
  /** From the run_end line; "running" when the file has none yet. */
  status: RunStatusLabel;
  stop_reason: string | null;
  escalation_rule: string | null;
  /** The run_end line's output summary, or the last line's when the run has no run_end yet. */
  summary: string;
  /** ISO time of the run_end line, or of the last line. */
  at: string;
};

const FILE = /^trace-([A-Za-z0-9_-]{1,80})\.jsonl$/;

/** The run_end line's status as the run's final status: its "ok" is a successful run. */
function finalStatus(line: TraceLine | undefined): RunStatusLabel {
  if (line === undefined) return "running";
  if (line.status === "needs_human") return "needs_human";
  if (line.status === "error") return "error";
  return "success";
}

/** Summarises one run from its lines; the final status, stop_reason and escalation rule come from the run_end line alone. */
export function summarise(runId: string, lines: readonly TraceLine[]): RunSummary {
  const end = [...lines].reverse().find((line) => line.agent_name === "Orchestrator" && line.action === "run_end");
  const last = lines[lines.length - 1];
  const asOf = /as_of=(\d{4}-\d{2}-\d{2})/.exec(end?.input_summary ?? lines.find((line) => line.action === "run_start")?.input_summary ?? "")?.[1] ?? null;
  return {
    run_id: runId,
    task: end?.task ?? last?.task ?? null,
    as_of: asOf,
    status: finalStatus(end),
    stop_reason: typeof end?.stop_reason === "string" ? end.stop_reason : null,
    escalation_rule: typeof end?.escalation_rule === "string" ? end.escalation_rule : null,
    summary: (end ?? last)?.output_summary ?? "",
    at: (end ?? last)?.timestamp ?? "",
  };
}

/** Every run in the logs directory, newest first. An unreadable file is left out. */
export async function listRuns(dir: string = logsDir()): Promise<RunSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs = await Promise.all(
    names.map(async (name): Promise<{ run: RunSummary; mtime: number } | null> => {
      const match = FILE.exec(name);
      if (match === null) return null;
      try {
        const file = path.join(dir, name);
        const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
        const run = summarise(match[1], parseTrace(text));
        return { run: { ...run, at: run.at || info.mtime.toISOString() }, mtime: info.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return runs
    .filter((entry): entry is { run: RunSummary; mtime: number } => entry !== null)
    .sort((a, b) => b.run.at.localeCompare(a.run.at) || b.mtime - a.mtime || a.run.run_id.localeCompare(b.run.run_id))
    .map((entry) => entry.run);
}

/** The review queue: every run whose final status is needs_human, newest first. */
export async function reviewQueue(dir?: string): Promise<RunSummary[]> {
  return (await listRuns(dir)).filter((run) => run.status === "needs_human");
}
