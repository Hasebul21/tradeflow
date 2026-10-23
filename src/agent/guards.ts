// The runtime guards: checks before a query, after a model reply, on a finding's citations and before a memory
// write. A guard has no side effect except its "Guard" trace line, and it never throws on bad input: it returns
// { ok: false, reason }. AGENTS.md rule 6 routes every query, model reply, finding and memory write through here.
// Server only: queries.ts loads data/ with node:fs.
import { z } from "zod";
import { loadConfig } from "./config";
import { QUERIES, isQueryId, loadQueryData, type QueryData, type QueryResult } from "./queries";
import type { RecalledMemory } from "./memory";
import { allowedMemoryWrite, allowedQuery } from "./policy";
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

/** A refusal by src/agent/policy.ts: one Guard line, action "policy_denied", status "blocked". */
function policyDenied(tracer: Tracer | undefined, input: string, reason: string): { ok: false; reason: string } {
  tracer?.log({ agent_name: GUARD, action: "policy_denied", input_summary: capped(input), output_summary: capped(reason), status: "blocked", why: reason });
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------------------------------------------
// beforeQuery

export type QueryCall = { query_id: string; params: unknown };
/** Who asks and for which task; the policy is checked only when a caller says it. */
export type QueryWho = { caller: string; task: string };
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
 * Checks src/agent/policy.ts for one call: may `who.caller` run this query for `who.task`? A refusal writes the
 * "policy_denied" Guard line. RunState.query uses it before a cache hit, so a cached result is no way round the policy.
 */
export function checkQueryPolicy(call: QueryCall, who: QueryWho, tracer?: Tracer): GuardResult {
  const verdict = allowedQuery({ caller: who.caller, task: who.task, query_id: String(call.query_id) });
  return verdict.ok ? { ok: true } : policyDenied(tracer, `beforeQuery ${String(call.query_id)} ${safeJson(call.params)}`, verdict.reason);
}

/**
 * Lets one named query through, or says why not: the id is in the registry, `who` (when given) may run it for its
 * task under src/agent/policy.ts, the params pass its schema, `as_of`
 * is inside the dates of the bars (a Friday or Saturday moves to the Thursday before, traced once as
 * "as_of_moved"), a what_if names a known symbol and a positive whole quantity, and the run's budget is not spent.
 * On success `params` holds the params with `as_of` resolved. `data` is loaded when the caller has none.
 */
export async function beforeQuery(
  call: QueryCall,
  budget: QueryBudget = { used: 0, max: defaultMaxQueries() },
  tracer?: Tracer,
  data?: QueryData,
  who?: QueryWho,
): Promise<BeforeQueryResult> {
  const id = String(call.query_id);
  const summary = `beforeQuery ${id} ${safeJson(call.params)}`;

  if (!isQueryId(id)) return block(tracer, summary, `Unknown query ${id}. It is not in the registry.`);

  if (who !== undefined) {
    const verdict = checkQueryPolicy(call, who, tracer);
    if (!verdict.ok) return verdict;
  }

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

/** The injection phrase `text` holds, as the pattern's source, or null. The orchestrator uses it on rows and memories. */
export function injectionIn(text: string): string | null {
  return INJECTION.find((pattern) => pattern.test(text))?.source ?? null;
}

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
        problems.push(`finding ${index + 1} does not match the finding schema (${issue.path.join(".") || "finding"}: ${issue.message})`);
        return;
      }
      if (task === "thesis_check" && (parsed.data.verdict === null || !THESIS_VERDICTS.includes(parsed.data.verdict))) {
        problems.push(`finding ${index + 1} has verdict ${JSON.stringify(parsed.data.verdict)}; a thesis verdict is confirmed, contradicted or open`);
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

/** Spaces as long as the match, so a masked text keeps every position of the original. */
const blank = (match: string) => " ".repeat(match.length);

/** A number in a text: its value and where it starts. */
export type NumberMatch = { value: number; index: number };

/** numbersIn with positions: each number and its index in `text`. The masking keeps the text's length. */
export function numberMatchesIn(text: string, ignore: readonly string[] = []): NumberMatch[] {
  // A model often writes a date with a non-breaking hyphen (2026‑03‑31); one character for one, so positions stay.
  let t = text.replace(/[\u2010\u2011\u2012\u2212]/g, "-");
  for (const id of [...ignore].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) t = t.split(id).join(blank(id));
  t = t
    .replace(UUID, blank)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, blank)
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b\\.?(?:\\s+\\d{4})?`, "gi"), blank)
    .replace(new RegExp(`\\b(?:${MONTHS})\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "gi"), blank)
    .replace(/\b[A-Za-z]+(?:-\d+)+\b/g, blank)
    .replace(/\b(?:19|20)\d{2}\b/g, blank)
    .replace(/\bTk\.?\s*/gi, blank);
  return [...t.matchAll(NUMBER)]
    .map((match) => ({ value: Number(match[0].replace(/,/g, "")), index: match.index }))
    .filter((n) => Number.isFinite(n.value));
}

/**
 * The numbers a text holds, as positive values. Dates (2026-10-01, 1 Oct, Oct 1), years, ids (j-013, BRK-20260802-035),
 * the `ignore` strings (run_query_ids), words with digits in them and a Tk prefix are not numbers. 3,000 is 3000.
 * The first day of a range such as 11-17 Sept is still a number here: a caller that can prove the range's days are
 * dates of its run blanks the range first (writer.ts checkReview and guards.checkCitations).
 */
export function numbersIn(text: string, ignore: readonly string[] = []): number[] {
  return numberMatchesIn(text, ignore).map((match) => match.value);
}

/** Days in one month written as a range, such as 11-17 Sept 2026 or Sep 11-17. month is 1 to 12; year is null when the text gives none. */
export type DayRange = { text: string; index: number; month: number; year: number | null; firstDay: number; lastDay: number };

const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const DASH = "\\s*[-\\u2013\\u2014]\\s*";
const RANGE_DAYS_FIRST = new RegExp(`(?<![\\d.,])\\b${DAY}${DASH}${DAY}\\s+(${MONTHS})\\b\\.?(?:\\s+(\\d{4})\\b)?`, "gi");
const RANGE_MONTH_FIRST = new RegExp(`\\b(${MONTHS})\\b\\.?\\s+${DAY}${DASH}${DAY}\\b(?![.,]\\d)(?:,?\\s+(\\d{4})\\b)?`, "gi");
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The day ranges in a text: a first and a last day joined by a hyphen or a dash, with one month name before or after
 * (11-17 Sept 2026, 11–17 Sep, Sep 11-17, 2026). Only ranges whose first day is before the last and both are 1 to 31.
 * numbersIn reads the day that has no month next to it as a number; this says where such ranges are, nothing more.
 */
export function dayRangesIn(text: string): DayRange[] {
  const out: DayRange[] = [];
  const push = (match: RegExpMatchArray, first: string, last: string, month: string, year: string | undefined) => {
    const firstDay = Number(first);
    const lastDay = Number(last);
    if (firstDay < 1 || lastDay > 31 || firstDay >= lastDay) return;
    out.push({ text: match[0], index: match.index ?? 0, month: MONTH_KEYS.indexOf(month.slice(0, 3).toLowerCase()) + 1, year: year === undefined ? null : Number(year), firstDay, lastDay });
  };
  for (const m of text.matchAll(RANGE_DAYS_FIRST)) push(m, m[1], m[2], m[3], m[4]);
  for (const m of text.matchAll(RANGE_MONTH_FIRST)) push(m, m[2], m[3], m[1], m[4]);
  return out.sort((a, b) => a.index - b.index);
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})/g;

function isoDatesIn(value: unknown, out: Set<string>, depth = 0): Set<string> {
  if (depth > 8) return out;
  if (typeof value === "string") for (const m of value.matchAll(ISO_DATE)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  else if (Array.isArray(value)) for (const item of value) isoDatesIn(item, out, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) isoDatesIn(item, out, depth + 1);
  return out;
}

/**
 * The dates a run worked with, as yyyy-mm-dd: as_of, every date a query of the run was given (its window), and every
 * date in the rows the given findings cite. Code-made values only: never a claim, a gap or any other model text.
 */
export function runDates(asOf: string | undefined, findings: readonly Pick<Finding, "cites">[], results: Record<string, QueryResult>): Set<string> {
  const out = isoDatesIn(asOf ?? "", new Set<string>());
  for (const result of Object.values(results)) isoDatesIn(result.params, out);
  for (const finding of findings) for (const cite of finding.cites) if (results[cite] !== undefined) isoDatesIn(results[cite].rows, out);
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function isRunDate(dates: ReadonlySet<string>, year: number | null, month: number, day: number): boolean {
  const monthDay = `-${pad2(month)}-${pad2(day)}`;
  return year === null ? [...dates].some((date) => date.endsWith(monthDay)) : dates.has(`${year}${monthDay}`);
}

/** A same-month day range left in the text because one of its days is not a date of the run; end is exclusive. */
export type UnprovenRange = { index: number; end: number; text: string };

/**
 * The text with every same-month day range (11-17 Sept 2026) whose first and last day are both in `dates` blanked
 * out, keeping each position, so the range reads as the date it is. A range with a day the run never had is left as
 * it is, and its loose day stays a number the caller must find in the data. Single dates are numbersIn's, unchanged.
 */
export function withoutRunRanges(text: string, dates: ReadonlySet<string>): { text: string; unproven: UnprovenRange[] } {
  let out = text;
  const unproven: UnprovenRange[] = [];
  for (const range of dayRangesIn(text)) {
    const proven = isRunDate(dates, range.year, range.month, range.firstDay) && isRunDate(dates, range.year, range.month, range.lastDay);
    if (proven) out = `${out.slice(0, range.index)}${" ".repeat(range.text.length)}${out.slice(range.index + range.text.length)}`;
    else unproven.push({ index: range.index, end: range.index + range.text.length, text: range.text });
  }
  return { text: out, unproven };
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

/** `finding` is the owner-facing number, counted from 1: the first finding is 1. */
export type CitationFailure = { finding: number; problem: string };
export type CitationResult = GuardResult & { failures: CitationFailure[] };

/**
 * Every finding cites at least one run_query_id that exists in this run; every value in its numbers list, and every
 * number in its claim, is in the cited rows (or in a recalled memory the finding lists in memory_ids). The claim's
 * numbers may also be in the numbers list. A finding with no numbers passes when its cites exist. A same-month day
 * range in a claim (11-17 Sept 2026) reads as a date only when both its days are dates of the run (`asOf`, a query's
 * window, a row the finding cites); otherwise its loose day is a number like any other.
 */
export function checkCitations(
  findings: readonly Finding[],
  results: Record<string, QueryResult>,
  memories: readonly RecalledMemory[] = [],
  tracer?: Tracer,
  asOf?: string,
): CitationResult {
  const failures: CitationFailure[] = [];
  const knownIds = Object.keys(results);
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));

  findings.forEach((candidate, index) => {
    const parsed = findingSchema.safeParse(candidate);
    if (!parsed.success) {
      failures.push({ finding: index + 1, problem: "the finding does not match the finding schema" });
      return;
    }
    const finding = parsed.data;
    if (finding.cites.length === 0) {
      failures.push({ finding: index + 1, problem: "it cites no run_query_id" });
      return;
    }
    const missing = finding.cites.filter((cite) => !Object.prototype.hasOwnProperty.call(results, cite));
    if (missing.length > 0) {
      failures.push({ finding: index + 1, problem: `it cites ${missing.join(", ")}, which does not exist in this run` });
      return;
    }

    const candidates: number[] = [];
    for (const cite of finding.cites) candidates.push(...numbersInRows(results[cite].rows, knownIds));
    for (const id of finding.memory_ids) {
      const memory = memoryById.get(id);
      if (memory !== undefined) candidates.push(...numbersIn(memory.content, knownIds));
    }

    for (const { value, label } of finding.numbers) {
      if (!matches(value, candidates)) failures.push({ finding: index + 1, problem: `the number ${value} (${label}) is not in the cited rows` });
    }
    const listed = finding.numbers.map((entry) => entry.value);
    const claim = withoutRunRanges(finding.claim, runDates(asOf, [finding], results)).text;
    for (const n of numbersIn(claim, [...knownIds, ...finding.cites])) {
      if (!matches(n, listed) && !matches(n, candidates)) failures.push({ finding: index + 1, problem: `the claim has ${n}, which is not in its numbers or the cited rows` });
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
/** `caller` is who writes: "Writer", "feedback" or "reconcile_approve". A write with no caller skips the policy check. */
export type MemoryWrite = { kind: "review" | "correction" | "decision"; text: string; caller?: string };

/**
 * What may enter memory: an accepted review's memory_note, an owner correction or an owner decision such as an
 * approval. Never raw rows (JSON), never empty, at most 600 characters, and never text that reads like an
 * instruction to the agents: the same injection phrases afterModel detects. A memory is read by every later run,
 * so an instruction stored once would reach every model after it. With a `caller`, src/agent/policy.ts must allow
 * that caller to write that kind; a refusal is a "policy_denied" Guard line.
 */
export function beforeRemember(write: MemoryWrite, tracer?: Tracer): GuardResult {
  const kind = String(write?.kind);
  const text = typeof write?.text === "string" ? write.text : "";
  const summary = `beforeRemember kind=${kind}, ${text.length} chars`;
  if (!["review", "correction", "decision"].includes(kind)) {
    return block(tracer, summary, `A ${kind} is not stored: memory keeps only a review's memory_note, an owner correction or an owner decision.`);
  }
  if (typeof write?.caller === "string") {
    const verdict = allowedMemoryWrite({ caller: write.caller, kind });
    if (!verdict.ok) return policyDenied(tracer, `${summary}, caller=${write.caller}`, verdict.reason);
  }
  if (text.trim() === "") return block(tracer, summary, "The memory text is empty.");
  if (text.length > MAX_MEMORY_CHARS) {
    return block(tracer, summary, `The memory text is ${text.length} characters; the limit is ${MAX_MEMORY_CHARS}.`);
  }
  if (/^\s*[[{]/.test(text)) return block(tracer, summary, "The memory text looks like raw rows (JSON); memory keeps a short note, not data.");
  const injection = INJECTION.find((pattern) => pattern.test(text));
  if (injection !== undefined) {
    return block(tracer, summary, `The memory text reads like an instruction to the agents (matched ${injection.source}); memory keeps the owner's words and accepted reviews, never instructions.`);
  }
  allow(tracer, summary, `${kind} allowed`);
  return { ok: true };
}
