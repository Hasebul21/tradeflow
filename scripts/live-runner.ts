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
export type LiveOutcome = { id: string; http: number | "cli" | null; reply: Record<string, unknown> | null; seconds: number; busyRetries: number; note: string | null };
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

/** Seconds from a Retry-After header, or 5 (the server's BUSY_RETRY_AFTER_S) when it is missing or not a number. */
export function retryAfterMs(headers: http.IncomingHttpHeaders): number {
  const raw = Array.isArray(headers["retry-after"]) ? headers["retry-after"][0] : headers["retry-after"];
  const seconds = raw === undefined ? NaN : Number(raw);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 5) * 1000;
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

/** POSTs one case, saves the reply to <out>/<id>.json and the trace to <out>/<id>.trace.jsonl. */
export async function runHttpCase(item: LiveCase, base: string, out: string, timeoutMs: number, options: { sleep?: (ms: number) => Promise<void>; onBusy?: (id: string, waitMs: number) => void } = {}): Promise<LiveOutcome> {
  const started = Date.now();
  try {
    const { reply, busyRetries } = await postRun(base, item.body, timeoutMs, { ...(options.sleep === undefined ? {} : { sleep: options.sleep }), onBusy: (ms) => options.onBusy?.(item.id, ms) });
    const seconds = (Date.now() - started) / 1000;
    const json = parseJson(reply.text);
    writeFileSync(path.join(out, `${item.id}.json`), `${json === null ? JSON.stringify({ http_status: reply.status, text: reply.text }) : JSON.stringify(json, null, 2)}\n`);
    const reply1 = isObject(json) ? json : null;
    const runId = typeof reply1?.run_id === "string" ? reply1.run_id : typeof item.body.run_id === "string" ? item.body.run_id : null;
    let note: string | null = null;
    if (reply.status === 429) note = "still busy after waiting the full timeout";
    else if (runId !== null) note = await saveTrace(base, runId, path.join(out, `${item.id}.trace.jsonl`), 60_000).catch((error: unknown) => `trace not saved: ${error instanceof Error ? error.message : String(error)}`);
    return { id: item.id, http: reply.status, reply: reply1, seconds, busyRetries, note };
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
  const tmp = mkdtempSync(path.join(os.tmpdir(), `tradeflow-e2e-${item.id}-`));
  try {
    const dataDir = path.join(tmp, "data");
    cpSync(source, dataDir, { recursive: true });
    const input = path.join(tmp, `${item.id}.json`);
    writeFileSync(input, JSON.stringify(item.body));
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "agent", "--", input, "--out", path.join(tmp, "out")], {
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
    if (existsSync(trace)) copyFileSync(trace, path.join(out, `${item.id}.trace.jsonl`));
    const reply = parseJson(readFileSync(resultFile, "utf8"));
    return done(isObject(reply) ? reply : null, existsSync(trace) ? null : "no trace file in logs/");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** "<case>  <http>  <status>  <stop_reason>  <seconds> s  <n> model calls", plus any note. */
export function summaryLine(outcome: LiveOutcome): string {
  const reply = outcome.reply;
  const output = isObject(reply?.output) ? reply.output : null;
  const error = isObject(reply?.error) ? reply.error : null;
  const usage = isObject(reply?.usage) ? reply.usage : null;
  const status = typeof reply?.status === "string" ? reply.status : "no reply";
  const stop = typeof output?.stop_reason === "string" ? output.stop_reason : typeof error?.type === "string" ? error.type : "-";
  const calls = typeof usage?.model_calls === "number" ? usage.model_calls : "-";
  const extra = [outcome.busyRetries > 0 ? `${outcome.busyRetries} busy retries` : null, outcome.note].filter((part) => part !== null).join("; ");
  return `${outcome.id}  ${outcome.http ?? "-"}  ${status}  ${stop}  ${outcome.seconds.toFixed(1)} s  ${calls} model calls${extra === "" ? "" : `  (${extra})`}`;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
