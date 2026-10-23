// The parts of npm run e2e:live that tests can call: the case list, one POST /run with the Busy retry, the trace
// fetch, a run of a fixture case through npm run agent, and the one-line summary. scripts/e2e-live.ts wires them
// together. Nothing here writes inside the repo except what the app itself writes (logs/), and every file the runner
// saves goes under the --out directory.
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

/** One case: a body for POST /run, or, for a red-team case with its own data_dir, a run through npm run agent. */
export type LiveCase = { id: string; body: Record<string, unknown>; dataDir?: string };
/** What the runner learned about one case. `http` is the HTTP status, or "cli" for an npm run agent case. */
export type LiveOutcome = { id: string; http: number | "cli" | null; reply: Record<string, unknown> | null; seconds: number; busyRetries: number; note: string | null; memory?: string | null };
type HttpReply = { status: number; headers: http.IncomingHttpHeaders; text: string };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** input_examples/*.json in name order, each body as it is; or, with `redteam`, each case in evals/redteam/cases.json. */
export function liveCases(root: string, redteam: boolean): LiveCase[] {
  if (redteam) {
    const cases = JSON.parse(readFileSync(path.join(root, "evals", "redteam", "cases.json"), "utf8")) as { id: string; data_dir?: string; input: Record<string, unknown> }[];
    return cases.map((item) => ({ id: item.id, body: { run_id: item.id, input: item.input }, ...(item.data_dir === undefined ? {} : { dataDir: item.data_dir }) }));
  }
  const dir = path.join(root, "input_examples");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ id: path.basename(name, ".json"), body: JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown> }));
}

/** One HTTP request with a JSON body or none. It gives up only after `timeoutMs` with no answer. */
export function request(method: "GET" | "POST", url: string, body: unknown, timeoutMs: number): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, { method, headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from ${target.origin} in ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The shortest wait between two Busy retries, so a Retry-After of 0 never turns into a tight loop. */
export const MIN_BUSY_WAIT_MS = 1000;

/** Seconds from a Retry-After header, or 5 (the server's BUSY_RETRY_AFTER_S) when it is missing or not a number; at least MIN_BUSY_WAIT_MS. */
export function retryAfterMs(headers: http.IncomingHttpHeaders): number {
  const raw = Array.isArray(headers["retry-after"]) ? headers["retry-after"][0] : headers["retry-after"];
  const seconds = raw === undefined ? NaN : Number(raw);
  return Math.max(MIN_BUSY_WAIT_MS, (Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000);
}

/**
 * POSTs `body` to <base>/run. On a 429 whose error.type is "Busy" it waits Retry-After and posts again, until it has
 * waited `timeoutMs` in all; any other answer is returned as it is. `onBusy` hears each wait.
 */
export async function postRun(
  base: string,
  body: unknown,
  timeoutMs: number,
  options: { sleep?: (ms: number) => Promise<void>; onBusy?: (waitMs: number) => void } = {},
): Promise<{ reply: HttpReply; busyRetries: number }> {
  const sleep = options.sleep ?? defaultSleep;
  let waited = 0;
  let busyRetries = 0;
  for (;;) {
    const reply = await request("POST", new URL("/run", base).toString(), body, timeoutMs);
    const json = parseJson(reply.text);
    const busy = reply.status === 429 && isObject(json) && isObject(json.error) && json.error.type === "Busy";
    if (!busy) return { reply, busyRetries };
    const wait = retryAfterMs(reply.headers);
    if (waited + wait > timeoutMs) return { reply, busyRetries };
    options.onBusy?.(wait);
    await sleep(wait);
    waited += wait;
    busyRetries += 1;
  }
}

/** GET <base>/run/<run_id> and writes its lines to `file` as JSONL. Returns null, or why no trace was saved. */
export async function saveTrace(base: string, runId: string, file: string, timeoutMs: number): Promise<string | null> {
  const reply = await request("GET", new URL(`/run/${encodeURIComponent(runId)}`, base).toString(), undefined, timeoutMs);
  const json = parseJson(reply.text);
  if (reply.status !== 200 || !isObject(json) || !Array.isArray(json.lines)) return `trace not saved: GET /run/${runId} answered ${reply.status}`;
  writeFileSync(file, json.lines.map((line) => JSON.stringify(line)).join("\n") + (json.lines.length > 0 ? "\n" : ""));
  return null;
}

/** The id of a recalled memory with what it is: "(review of example_3a)", "(correction)" or its first tag. */
function memoryLabel(id: string, reply: Record<string, unknown> | null): string {
  const output = isObject(reply?.output) ? reply.output : null;
  const recalled = Array.isArray(output?.memories_recalled) ? output.memories_recalled : [];
  const found = recalled.find((memory) => isObject(memory) && memory.id === id);
  const tags = isObject(found) && Array.isArray(found.tags) ? found.tags.filter((tag): tag is string => typeof tag === "string") : [];
  if (tags.includes("correction")) return `${id} (correction)`;
  const run = tags.find((tag) => tag.startsWith("run:"));
  if (tags.includes("review")) return `${id} (review of ${run === undefined ? "an earlier run" : run.slice(4)})`;
  return tags.length > 0 ? `${id} (${tags[0]})` : id;
}

/**
 * What the run recalled, from the Memory.recall line(s) of its saved trace: "by_tag=<ids>; by_query=<ids>", each id
 * labelled from the reply's memories_recalled. Null when the trace has no recall line (the task recalls nothing).
 */
export function memorySeen(traceFile: string, reply: Record<string, unknown> | null): string | null {
  if (!existsSync(traceFile)) return null;
  const parts: string[] = [];
  for (const line of readFileSync(traceFile, "utf8").split("\n")) {
    const entry = line.trim() === "" ? null : parseJson(line);
    if (!isObject(entry) || entry.agent_name !== "Memory" || entry.action !== "recall" || typeof entry.output_summary !== "string") continue;
    const pick = (key: string) => (entry.output_summary as string).match(new RegExp(`${key}=([^;]*)`))?.[1]?.trim() ?? "none";
    const label = (ids: string) => (ids === "none" ? "none" : ids.split(",").map((id) => memoryLabel(id.trim(), reply)).join(", "));
    parts.push(`by_tag=${label(pick("by_tag"))}; by_query=${label(pick("by_query"))}`);
  }
  return parts.length === 0 ? null : parts.join(" | ");
}

/**
 * POSTs one case, saves the reply to <out>/<id>.json and the trace to <out>/<id>.trace.jsonl. A case still answered
 * 429 Busy after the whole wait has no result: its reply is null.
 */
export async function runHttpCase(item: LiveCase, base: string, out: string, timeoutMs: number, options: { sleep?: (ms: number) => Promise<void>; onBusy?: (id: string, waitMs: number) => void } = {}): Promise<LiveOutcome> {
  const started = Date.now();
  try {
    const { reply, busyRetries } = await postRun(base, item.body, timeoutMs, { ...(options.sleep === undefined ? {} : { sleep: options.sleep }), onBusy: (ms) => options.onBusy?.(item.id, ms) });
    const seconds = (Date.now() - started) / 1000;
    const json = parseJson(reply.text);
    writeFileSync(path.join(out, `${item.id}.json`), `${json === null ? JSON.stringify({ http_status: reply.status, text: reply.text }) : JSON.stringify(json, null, 2)}\n`);
    if (reply.status === 429) return { id: item.id, http: 429, reply: null, seconds, busyRetries, note: "no result: still 429 Busy after waiting the full timeout" };
    const reply1 = isObject(json) ? json : null;
    const runId = typeof reply1?.run_id === "string" ? reply1.run_id : typeof item.body.run_id === "string" ? item.body.run_id : null;
    const traceFile = path.join(out, `${item.id}.trace.jsonl`);
    let note: string | null = null;
    if (runId !== null) note = await saveTrace(base, runId, traceFile, 60_000).catch((error: unknown) => `trace not saved: ${error instanceof Error ? error.message : String(error)}`);
    return { id: item.id, http: reply.status, reply: reply1, seconds, busyRetries, note, memory: memorySeen(traceFile, reply1) };
  } catch (error) {
    return { id: item.id, http: null, reply: null, seconds: (Date.now() - started) / 1000, busyRetries: 0, note: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Runs a red-team case that names a data_dir through npm run agent, as the eval does: on a temporary copy of that
 * fixture (so the fixture is never written), with ZETARIS_REST_URL empty so every query runs locally (the fixture is
 * not in Postgres). Saves the result and logs/trace-<id>.jsonl under `out`. It needs the fixtures made first.
 */
export async function runCliCase(item: LiveCase, root: string, out: string, timeoutMs: number): Promise<LiveOutcome> {
  const started = Date.now();
  const source = path.resolve(root, item.dataDir as string);
  const done = (reply: Record<string, unknown> | null, note: string | null): LiveOutcome => ({ id: item.id, http: "cli", reply, seconds: (Date.now() - started) / 1000, busyRetries: 0, note });
  if (!existsSync(source)) return done(null, `${item.dataDir} is missing: run npm run make-fixtures first`);
  let tmp: string | null = null;
  try {
    tmp = mkdtempSync(path.join(os.tmpdir(), `tradeflow-e2e-${item.id}-`));
    const dataDir = path.join(tmp, "data");
    cpSync(source, dataDir, { recursive: true });
    const input = path.join(tmp, `${item.id}.json`);
    writeFileSync(input, JSON.stringify(item.body));
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "agent", "--", input, "--out", path.join(tmp as string, "out")], {
        cwd: root,
        env: { ...process.env, TRADEFLOW_DATA_DIR: dataDir, ZETARIS_REST_URL: "" },
        stdio: ["ignore", "ignore", "inherit"],
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", () => resolve(null));
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const resultFile = path.join(tmp, "out", `${item.id}.json`);
    if (!existsSync(resultFile)) return done(null, `npm run agent wrote no result (exit code ${code})`);
    copyFileSync(resultFile, path.join(out, `${item.id}.json`));
    const trace = path.join(root, "logs", `trace-${item.id}.jsonl`);
    const traceFile = path.join(out, `${item.id}.trace.jsonl`);
    if (existsSync(trace)) copyFileSync(trace, traceFile);
    const parsed = parseJson(readFileSync(resultFile, "utf8"));
    const reply = isObject(parsed) ? parsed : null;
    return { ...done(reply, existsSync(trace) ? null : "no trace file in logs/"), memory: memorySeen(traceFile, reply) };
  } catch (error) {
    return done(null, `npm run agent failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }
}

/** "<case>  <http>  <status>  <stop_reason>  <seconds> s  <n> model calls  memory: <what it recalled>", plus any note. */
export function summaryLine(outcome: LiveOutcome): string {
  const reply = outcome.reply;
  const output = isObject(reply?.output) ? reply.output : null;
  const error = isObject(reply?.error) ? reply.error : null;
  const usage = isObject(reply?.usage) ? reply.usage : null;
  const status = typeof reply?.status === "string" ? reply.status : "no reply";
  const stop = typeof output?.stop_reason === "string" ? output.stop_reason : typeof error?.type === "string" ? error.type : "-";
  const calls = typeof usage?.model_calls === "number" ? usage.model_calls : "-";
  const extra = [outcome.busyRetries > 0 ? `${outcome.busyRetries} busy retries` : null, outcome.note].filter((part) => part !== null).join("; ");
  const memory = outcome.memory === undefined || outcome.memory === null ? "" : `  memory: ${outcome.memory}`;
  return `${outcome.id}  ${outcome.http ?? "-"}  ${status}  ${stop}  ${outcome.seconds.toFixed(1)} s  ${calls} model calls${memory}${extra === "" ? "" : `  (${extra})`}`;
}

/**
 * Runs one group's cases in order with `runCase` and hands each outcome to `record`. A case with no result (reply
 * null) stops the group: each later case reads what it should have written, so each is recorded as not run.
 */
export async function runLiveGroup(group: readonly string[], runCase: (id: string) => Promise<LiveOutcome>, record: (outcome: LiveOutcome) => void): Promise<void> {
  for (const [position, id] of group.entries()) {
    const outcome = await runCase(id);
    record(outcome);
    if (outcome.reply !== null) continue;
    for (const later of group.slice(position + 1)) {
      record({ id: later, http: null, reply: null, seconds: 0, busyRetries: 0, note: `not run: ${id} in its chain got no result` });
    }
    return;
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
