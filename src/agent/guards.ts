// The runtime guards: checks before a query, after a model reply, on a finding's citations and before a memory
// write. A guard has no side effect except its "Guard" trace line, and it never throws on bad input: it returns
// { ok: false, reason }. AGENTS.md rule 6 routes every query, model reply, finding and memory write through here.
// Server only: queries.ts loads data/ with node:fs.
import { z } from "zod";
import { loadConfig } from "./config";
import { QUERIES, isQueryId, loadQueryData, type QueryData, type QueryResult } from "./queries";
import type { RecalledMemory } from "./memory";
import type { Tracer } from "./trace";
import { resolveAsOf } from "@/lib/portfolio-view";
import { normalizeSymbol } from "@/lib/symbol";

export type GuardResult = { ok: true } | { ok: false; reason: string };

const GUARD = "Guard";
const SUMMARY_CHARS = 200;
const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function allow(tracer: Tracer | undefined, input: string, output: string, extra: { why?: string } = {}): void {
  tracer?.log({ agent_name: GUARD, action: "allow", input_summary: capped(input), output_summary: capped(output), status: "ok", ...extra });
}

function block(tracer: Tracer | undefined, input: string, reason: string): { ok: false; reason: string } {
  tracer?.log({ agent_name: GUARD, action: "block", input_summary: capped(input), output_summary: capped(reason), status: "blocked", why: reason });
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------------------------------------------
// beforeQuery

export type QueryCall = { query_id: string; params: unknown };
/** `used` is the calls this run has already made; `max` is MAX_QUERY_CALLS. */
export type QueryBudget = { used: number; max: number };
export type BeforeQueryResult = { ok: true; params: Record<string, unknown> } | { ok: false; reason: string };

function defaultMaxQueries(): number {
  try {
    return loadConfig(process.env, () => {}).MAX_QUERY_CALLS;
  } catch {
    return 20;
  }
}

/**
 * Lets one named query through, or says why not: the id is in the registry, the params pass its schema, `as_of`
 * is inside the dates of the bars (a Friday or Saturday moves to the Thursday before, traced once as
 * "as_of_moved"), a what_if names a known symbol and a positive whole quantity, and the run's budget is not spent.
 * On success `params` holds the params with `as_of` resolved. `data` is loaded when the caller has none.
 */
export async function beforeQuery(
  call: QueryCall,
  budget: QueryBudget = { used: 0, max: defaultMaxQueries() },
  tracer?: Tracer,
  data?: QueryData,
): Promise<BeforeQueryResult> {
  const id = String(call.query_id);
  const summary = `beforeQuery ${id} ${safeJson(call.params)}`;

  if (!isQueryId(id)) return block(tracer, summary, `Unknown query ${id}. It is not in the registry.`);

  // The schema also rejects these, but the reason says what is wrong with the trade.
  if (id === "what_if" && isRecord(call.params) && "quantity" in call.params) {
    const quantity = call.params.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
      return block(tracer, summary, `${id}: quantity must be a positive whole number of shares.`);
    }
  }

  const parsed = QUERIES[id].params.safeParse(call.params ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ");
    return block(tracer, summary, `${id}: params do not match the query's schema (${why}).`);
  }
  let params = parsed.data as Record<string, unknown>;

  let loaded: QueryData;
  try {
    loaded = data ?? (await loadQueryData());
  } catch {
    return block(tracer, summary, "The data could not be loaded, so the dates and symbols cannot be checked.");
  }

  let moved: { from: string; to: string } | null = null;
  if (typeof params.as_of === "string") {
    const resolved = resolveAsOf(loaded.portfolio.bars, params.as_of);
    if (!resolved.ok) return block(tracer, summary, `${id}: ${resolved.error}`);
    if (resolved.asOf !== params.as_of) {
      moved = { from: params.as_of, to: resolved.asOf };
      params = { ...params, as_of: resolved.asOf };
    }
  }

  if (id === "what_if") {
    const symbol = normalizeSymbol(String(params.symbol));
    if (!loaded.portfolio.instruments.has(symbol)) return block(tracer, summary, `${id}: ${symbol} is not in instruments.`);
  }

  if (budget.used >= budget.max) {
    return block(tracer, summary, `The run's query budget is spent: ${budget.used} of ${budget.max} calls used.`);
  }

  if (moved !== null) {
    tracer?.log({
      agent_name: GUARD,
      action: "as_of_moved",
      input_summary: capped(`${id} as_of ${moved.from}`),
      output_summary: `as_of moved from ${moved.from} to ${moved.to}`,
      status: "ok",
    });
  }
  allow(tracer, summary, `${id} allowed (${budget.used + 1} of ${budget.max})`);
  return { ok: true, params };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "[unreadable params]";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// afterModel

/** A finding, as the Analyst writes it. `verdict` and `proposed_fix` are null when they do not apply. */
export const findingSchema = z.object({
  kind: z.string().min(1),
  subject: z.string().min(1),
  claim: z.string().min(1),
  numbers: z.array(z.object({ value: z.number().finite(), label: z.string() })),
  cites: z.array(z.string()),
  verdict: z.string().nullable(),
  proposed_fix: z.string().nullable(),
  memory_ids: z.array(z.string()),
});
export type Finding = z.infer<typeof findingSchema>;

const THESIS_VERDICTS = ["confirmed", "contradicted", "open"];

const ADVICE = [
  /\byou\s+should\s+(buy|sell|hold)\b/i,
  /\bsell\s+now\b/i,
  /\bbuy\s+now\b/i,
  /\bgo\s+ahead\s+and\s+buy\b/i,
  /\bgo\s+ahead\b/i,
  /\bi\s+recommend\s+(buying|selling|holding)\b/i,
  /\bdon['’]?t\s+buy\b/i,
];
const INJECTION = [/ignore\s+previous\s+instructions/i, /\byou\s+are\s+now\b/i, /\btell\s+the\s+owner\s+to\b/i];

function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsIn(item, out, depth + 1);
  return out;
}

export type AfterModelResult = GuardResult & { injection_seen: boolean };

/**
 * Checks one model reply. Every finding in `reply.findings` passes the finding schema; no string in the reply
 * tells the owner to buy, sell or hold; in the thesis_check task (`input.task`) a finding's verdict is confirmed,
 * contradicted or open. Wording that looks like an injection sets `injection_seen`; it does not block by itself.
 * Each agent's own reply schema is added by the step that defines the agent.
 */
export function afterModel(agent: string, reply: unknown, input: unknown, tracer?: Tracer): AfterModelResult {
  const task = isRecord(input) && typeof input.task === "string" ? input.task : undefined;
  const summary = `afterModel ${agent}${task === undefined ? "" : ` task=${task}`}`;
  const problems: string[] = [];

  if (isRecord(reply) && Array.isArray(reply.findings)) {
    reply.findings.forEach((candidate, index) => {
      const parsed = findingSchema.safeParse(candidate);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        problems.push(`finding ${index} does not match the finding schema (${issue.path.join(".") || "finding"}: ${issue.message})`);
        return;
      }
      if (task === "thesis_check" && (parsed.data.verdict === null || !THESIS_VERDICTS.includes(parsed.data.verdict))) {
        problems.push(`finding ${index} has verdict ${JSON.stringify(parsed.data.verdict)}; a thesis verdict is confirmed, contradicted or open`);
      }
    });
  }

  const text = stringsIn(reply).join("\n");
  const advice = ADVICE.find((pattern) => pattern.test(text));
  if (advice !== undefined) problems.push(`the reply tells the owner what to trade (matched ${advice.source})`);
  const injection_seen = INJECTION.some((pattern) => pattern.test(text));

  if (problems.length > 0) {
    const reason = `${agent} reply blocked: ${problems.join("; ")}.`;
    block(tracer, `${summary}${injection_seen ? " injection_seen" : ""}`, reason);
    return { ok: false, reason, injection_seen };
  }
  allow(tracer, summary, injection_seen ? "reply allowed; injection wording seen" : "reply allowed", injection_seen ? { why: "injection_seen" } : {});
  return { ok: true, injection_seen };
}

// ---------------------------------------------------------------------------------------------------------------
// checkCitations

const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMBER = /(?<![A-Za-z0-9_])(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![A-Za-z0-9_])/g;

/**
 * The numbers a text holds, as positive values. Dates (2026-10-01, 1 Oct, Oct 1), years, ids (j-013, BRK-20260802-035),
 * the `ignore` strings (run_query_ids), words with digits in them and a Tk prefix are not numbers. 3,000 is 3000.
 */
export function numbersIn(text: string, ignore: readonly string[] = []): number[] {
  let t = text;
  for (const id of [...ignore].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) t = t.split(id).join(" ");
  t = t
    .replace(UUID, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b\\.?(?:\\s+\\d{4})?`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${MONTHS})\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "gi"), " ")
    .replace(/\b[A-Za-z]+(?:-\d+)+\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\bTk\.?\s*/gi, " ");
  return [...t.matchAll(NUMBER)].map((match) => Number(match[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Same number, allowing the sign (a fall written as 14.9 or -14.9) and rounding to one decimal place. */
function matches(value: number, candidates: readonly number[]): boolean {
  const v = Math.abs(value);
  return candidates.some((c) => {
    const a = Math.abs(c);
    return Math.abs(a - v) < 1e-9 || Math.abs(round1(a) - v) < 1e-9;
  });
}

function numbersInRows(value: unknown, ignore: readonly string[], out: number[] = [], depth = 0): number[] {
  if (depth > 8) return out;
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
  } else if (typeof value === "string") out.push(...numbersIn(value, ignore));
  else if (Array.isArray(value)) for (const item of value) numbersInRows(item, ignore, out, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) numbersInRows(item, ignore, out, depth + 1);
  return out;
}

export type CitationFailure = { finding: number; problem: string };
export type CitationResult = GuardResult & { failures: CitationFailure[] };

/**
 * Every finding cites at least one run_query_id that exists in this run; every value in its numbers list, and every
 * number in its claim, is in the cited rows (or in a recalled memory the finding lists in memory_ids). The claim's
 * numbers may also be in the numbers list. A finding with no numbers passes when its cites exist.
 */
export function checkCitations(
  findings: readonly Finding[],
  results: Record<string, QueryResult>,
  memories: readonly RecalledMemory[] = [],
  tracer?: Tracer,
): CitationResult {
  const failures: CitationFailure[] = [];
  const knownIds = Object.keys(results);
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));

  findings.forEach((candidate, index) => {
    const parsed = findingSchema.safeParse(candidate);
    if (!parsed.success) {
      failures.push({ finding: index, problem: "the finding does not match the finding schema" });
      return;
    }
    const finding = parsed.data;
    if (finding.cites.length === 0) {
      failures.push({ finding: index, problem: "it cites no run_query_id" });
      return;
    }
    const missing = finding.cites.filter((cite) => !Object.prototype.hasOwnProperty.call(results, cite));
    if (missing.length > 0) {
      failures.push({ finding: index, problem: `it cites ${missing.join(", ")}, which does not exist in this run` });
      return;
    }

    const candidates: number[] = [];
    for (const cite of finding.cites) candidates.push(...numbersInRows(results[cite].rows, knownIds));
    for (const id of finding.memory_ids) {
      const memory = memoryById.get(id);
      if (memory !== undefined) candidates.push(...numbersIn(memory.content, knownIds));
    }

    for (const { value, label } of finding.numbers) {
      if (!matches(value, candidates)) failures.push({ finding: index, problem: `the number ${value} (${label}) is not in the cited rows` });
    }
    const listed = finding.numbers.map((entry) => entry.value);
    for (const n of numbersIn(finding.claim, [...knownIds, ...finding.cites])) {
      if (!matches(n, listed) && !matches(n, candidates)) failures.push({ finding: index, problem: `the claim has ${n}, which is not in its numbers or the cited rows` });
    }
  });

  const summary = `checkCitations ${findings.length} findings, ${knownIds.length} results`;
  if (failures.length > 0) {
    const reason = failures.map((f) => `finding ${f.finding}: ${f.problem}`).join("; ");
    block(tracer, summary, reason);
    return { ok: false, reason, failures };
  }
  allow(tracer, summary, "every finding cites a result of this run and every number is in the cited rows");
  return { ok: true, failures };
}

// ---------------------------------------------------------------------------------------------------------------
// beforeRemember

export const MAX_MEMORY_CHARS = 600;
export type MemoryWrite = { kind: "review" | "correction" | "decision"; text: string };

/**
 * What may enter memory: an accepted review's memory_note, an owner correction or an owner decision such as an
 * approval. Never raw rows (JSON), never empty, at most 600 characters.
 */
export function beforeRemember(write: MemoryWrite, tracer?: Tracer): GuardResult {
  const kind = String(write?.kind);
  const text = typeof write?.text === "string" ? write.text : "";
  const summary = `beforeRemember kind=${kind}, ${text.length} chars`;
  if (!["review", "correction", "decision"].includes(kind)) {
    return block(tracer, summary, `A ${kind} is not stored: memory keeps only a review's memory_note, an owner correction or an owner decision.`);
  }
  if (text.trim() === "") return block(tracer, summary, "The memory text is empty.");
  if (text.length > MAX_MEMORY_CHARS) {
    return block(tracer, summary, `The memory text is ${text.length} characters; the limit is ${MAX_MEMORY_CHARS}.`);
  }
  if (/^\s*[[{]/.test(text)) return block(tracer, summary, "The memory text looks like raw rows (JSON); memory keeps a short note, not data.");
  allow(tracer, summary, `${kind} allowed`);
  return { ok: true };
}
