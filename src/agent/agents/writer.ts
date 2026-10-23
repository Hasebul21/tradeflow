// The Writer: turns the accepted findings into the owner's review. One call to the strong model (llm.ts falls back
// to main) with prompts/writer.md as-is and one JSON user message (rule 7): the accepted findings, each with the
// rows it cites, the gaps, declined_advice, the escalation, the recalled memories and the applied corrections. Code
// checks the reply: every number in the summary, the review and the memory note is in an accepted finding's
// numbers, in a cited row, in a recalled memory, in the question or in a gap code wrote (rounding to one decimal
// place; digits in dates, years, ids and [q:...] tags are not numbers, as before, and a same-month day range such as
// 11-17 Sept is a date only when both its days are dates of this run); the last line of the review is the disclaimer;
// guards.afterModel passes. When the disclaimer line is the only problem, code puts it last and checks again, with no
// model call (traced as disclaimer_added). Any other failure gets one retry with the same input plus retry_reason (each
// refused number with the words around it, then what to fix); a second failure returns ok false with the draft, which the
// loop turns into needs_human. An accepted review's memory_note goes to memory.remember, so through
// guards.beforeRemember with kind "review"; when afterModel saw injection wording in the reply, the memory_note is
// not stored at all (traced as memory_skipped), so instruction-like text never reaches a later run. Server only
// (node:fs, memory.ts).
import { z } from "zod";
import { loadConfig, WRITER_MAX_ATTEMPTS, type Config } from "../config";
import { citedResultsForSubjects, forModel, trimCitedResultsToSize, type ResultForModel, type ResultStore, type Task } from "../context";
import { afterModel, numberMatchesIn, numbersIn, runDates, withoutRunRanges, type Finding } from "../guards";
import { complete as completeModel, failedCallUsage, schemaReason, type CompleteOptions, type CompleteResult } from "../llm";
import { promptVersion, type PromptVersion } from "../prompts";
import { MemoryBlockedError, remember, type RecalledMemory } from "../memory";
import type { QueryId, Row } from "../queries";
import type { RunState } from "../run-state";
import type { Tracer } from "../trace";

const AGENT = "Writer";
const TARGET = "Orchestrator";
const SUMMARY_CHARS = 200;
/** One retry after a failed check, then needs_human. */
const MAX_ATTEMPTS = WRITER_MAX_ATTEMPTS;

export const DISCLAIMER = "This is a review of your own records, not financial advice.";

/** pre_trade: the rule the trade would break. sector or symbol, before and after, are the weights in percent, when what_if shows them. */
export type Escalation = { rule: string; message: string; sector?: string; symbol?: string; before?: number | null; after?: number | null };

/** What the orchestrator hands the Writer. The cited rows are taken from the run's store here. */
export type WriteInput = {
  task: Task;
  question: string;
  as_of: string;
  /** The findings the Evaluator accepted. */
  findings: readonly Finding[];
  /** Every result of this run in full (RunState.store). */
  results: ResultStore;
  gaps?: readonly string[];
  /** The subset of gaps that code wrote; only their figures may be repeated. The Analyst's own gap text never counts. */
  code_gaps?: readonly string[];
  declined_advice?: boolean;
  /** pre_trade: the rule the trade would break, decided in code; null otherwise. */
  escalation?: Escalation | null;
  /** The memories recalled for this run. */
  memories?: readonly RecalledMemory[];
  /** For the memory write. */
  runId: string;
  /** The run's own counts, computed in code by the orchestrator; the number check allows these and nothing else new. */
  counts?: RunCounts;
};

/**
 * The run's own counts, so a review may say "4 proposals" when the run has 4. Computed in code from the run, never
 * from model text: the accepted findings, the proposals (reconcile only; null otherwise), the distinct cited results
 * and the rounds run.
 */
export type RunCounts = { findings: number; proposals: number | null; citations: number; rounds: number };

/** The counts as allowed numbers. */
export function countNumbers(counts: RunCounts | undefined): number[] {
  if (counts === undefined) return [];
  return [counts.findings, counts.citations, counts.rounds, ...(counts.proposals === null ? [] : [counts.proposals])];
}

/** A memory as the Writer sees it: id, tags and content. */
export type MemoryForWriter = Pick<RecalledMemory, "id" | "tags" | "content">;
/** The rows of one cited result that are about the finding, or the whole trimmed result when none names its subject. */
export type CitedRows = { run_query_id: string; query_id: QueryId; rows: Row[] };
export type WriterFinding = Finding & { cited_rows: CitedRows[] };

/** The user message, exactly as the model sees it. retry_reason is null on the first call. */
export type WriterInput = {
  task: Task;
  question: string;
  as_of: string;
  findings: WriterFinding[];
  gaps: string[];
  declined_advice: boolean;
  escalation: Escalation | null;
  memories: MemoryForWriter[];
  applied_corrections: MemoryForWriter[];
  retry_reason: string | null;
  /** Only for thesis_check: each cited result once per run_query_id, with the rows that match the findings' subjects. */
  results?: ResultForModel[];
};

export type WriteDeps = {
  tracer: Tracer;
  /** The run's budget: when given, each model call goes through beforeModelCall and afterModelCall, and its config and sample mode are the defaults. */
  run?: Pick<RunState, "beforeModelCall" | "afterModelCall" | "afterFailedModelCall" | "modelCallsLeft" | "config" | "sampleMode"> & Partial<Pick<RunState, "tokensLeft">>;
  config?: Config;
  sampleMode?: boolean;
  /** The time left in the run for each model call. */
  timeoutMs?: number;
  /** When the round ends; passed on to llm.ts for its empty_response retries. */
  roundDeadlineMs?: number;
  /** The run's cancel signal; it goes to every model call this agent makes. */
  signal?: AbortSignal;
  /** The loop round, 0 in the first; written as retry_count on the trace lines. */
  round?: number;
  /** Default true. False keeps the memory_note out of memory, for a run that ends as needs_human. */
  remember?: boolean;
  /** For tests: a stand-in for llm.ts's complete. */
  complete?: (options: CompleteOptions) => Promise<CompleteResult>;
};

// The reply the prompt defines.
export const writerReplySchema = z.object({
  summary: z.string().trim().min(1),
  review_markdown: z.string().trim().min(1),
  memory_note: z.string().trim().min(1),
});
export type WriterReply = z.infer<typeof writerReplySchema>;

/** The reply's shape as prompts/writer.md gives it, restated by llm.ts when it asks again after a bad reply. */
export const WRITER_REPLY_SHAPE = '{"summary": "...", "review_markdown": "...", "memory_note": "..."}, each a non-empty string';

/** Why a parsed reply fails the Writer schema (the first issue), or null; llm.ts asks again with it. */
export function writerReplyProblem(json: Record<string, unknown>): string | null {
  const parsed = writerReplySchema.safeParse(json);
  if (parsed.success) return null;
  return schemaReason(parsed.error.issues[0]);
}

export type WriteOutcome = {
  ok: boolean;
  summary: string;
  review_markdown: string;
  memory_note: string;
  /** Why the review was refused; null when ok. */
  reason: string | null;
  /** The id of the stored memory; null when nothing was stored. */
  memory_id: string | null;
  /** Why the memory was not stored, when the guard refused it. */
  memory_reason: string | null;
  /** True when guards.afterModel saw injection wording in the last reply checked. */
  injection_seen: boolean;
  attempts: number;
  model: {
    model_id: string;
    source: CompleteResult["source"];
    /** Summed over the attempts; null when no call reported usage. */
    usage: { tokens_in: number; tokens_out: number } | null;
    calls: number;
    duration_ms: number;
    fallback?: CompleteResult["fallback"];
  };
};

/** prompts/writer.md as-is with its hash, read once (prompts.ts). */
export function writerPromptVersion(): PromptVersion {
  return promptVersion("writer");
}

/** The text of prompts/writer.md. */
export function writerPrompt(): string {
  return writerPromptVersion().text;
}

const capped = (text: string) => (text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}...`);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function depsOf(arg: Tracer | WriteDeps): WriteDeps {
  return "log" in arg && typeof arg.log === "function" ? { tracer: arg } : (arg as WriteDeps);
}

// ---------------------------------------------------------------------------------------------------------------
// The user message.

/** The rows of each cited result that name the finding's subject in a cell; the whole trimmed result when none does. */
export function citedRowsFor(finding: Finding, store: ResultStore, maxRows?: number): CitedRows[] {
  const out: CitedRows[] = [];
  for (const cite of [...new Set(finding.cites)]) {
    const result = store[cite];
    if (result === undefined) continue;
    const trimmed = forModel(result, maxRows);
    const about = trimmed.rows.filter((row) => Object.values(row).some((cell) => typeof cell === "string" && cell === finding.subject));
    out.push({ run_query_id: trimmed.run_query_id, query_id: trimmed.query_id, rows: about.length > 0 ? about : trimmed.rows });
  }
  return out;
}

const forWriter = ({ id, tags, content }: RecalledMemory): MemoryForWriter => ({ id, tags: [...tags], content });

/** Builds the user message: the findings with their cited rows, the memories as id, tags and content, the corrections among them. */
export function writerInput(input: WriteInput, config?: Config, retryReason: string | null = null): WriterInput {
  const memories = (input.memories ?? []).map(forWriter);
  const thesis = input.task === "thesis_check";
  const base: WriterInput = {
    task: input.task,
    question: input.question,
    as_of: input.as_of,
    // thesis_check: the rows go once per run_query_id in `results`, never again under each finding.
    findings: input.findings.map((finding) => ({ ...finding, cited_rows: thesis ? [] : citedRowsFor(finding, input.results, config?.MAX_ROWS_PER_QUERY) })),
    gaps: [...(input.gaps ?? [])],
    declined_advice: input.declined_advice === true,
    escalation: input.escalation ?? null,
    memories,
    applied_corrections: memories.filter((memory) => memory.tags.includes("correction")),
    retry_reason: retryReason,
  };
  if (!thesis) return base;
  // The Writer writes the whole review in one call, so its prompt is the largest in a 30-thesis run. Fit the
  // cited rows under MAX_PROMPT_CHARS (system plus user); the retry_reason above is already counted.
  const cfg = config ?? loadConfig(process.env, () => {});
  const results = citedResultsForSubjects(input.findings, input.results, cfg.MAX_ROWS_PER_QUERY);
  const emptyChars = JSON.stringify({ ...base, results: [] }).length;
  const budget = cfg.MAX_PROMPT_CHARS - writerPromptVersion().text.length - emptyChars + 2;
  return { ...base, results: trimCitedResultsToSize(results, Math.max(0, budget)) };
}

// ---------------------------------------------------------------------------------------------------------------
// The code check on a reply.

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Same number, allowing the sign and rounding the candidate to one decimal place. */
function matches(value: number, candidates: readonly number[]): boolean {
  const v = Math.abs(value);
  return candidates.some((c) => {
    const a = Math.abs(c);
    return Math.abs(a - v) < 1e-9 || Math.abs(round1(a) - v) < 1e-9;
  });
}

function numbersInValue(value: unknown, ignore: readonly string[], out: number[] = [], depth = 0): number[] {
  if (depth > 8) return out;
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
  } else if (typeof value === "string") out.push(...numbersIn(value, ignore));
  else if (Array.isArray(value)) for (const item of value) numbersInValue(item, ignore, out, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) numbersInValue(item, ignore, out, depth + 1);
  return out;
}

/** Every figure the review may use: the accepted findings' numbers, every cell of every cited result, the recalled memories. */
export function allowedNumbers(findings: readonly Finding[], store: ResultStore, memories: readonly Pick<RecalledMemory, "content">[]): number[] {
  const ids = Object.keys(store);
  const out: number[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    out.push(...finding.numbers.map((entry) => entry.value));
    for (const cite of finding.cites) {
      if (seen.has(cite) || store[cite] === undefined) continue;
      seen.add(cite);
      numbersInValue(store[cite].rows, ids, out);
    }
  }
  for (const memory of memories) out.push(...numbersIn(memory.content, ids));
  return out;
}

const SNIPPET_CHARS = 30;

/** The words around position `index` of `text`, on one line, for a reason the model can act on. */
function around(text: string, index: number, length: number): string {
  const from = Math.max(0, index - SNIPPET_CHARS);
  const to = Math.min(text.length, index + length + SNIPPET_CHARS);
  const body = text.slice(from, to).replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return `${from > 0 ? "..." : ""}${body}${to < text.length ? "..." : ""}`;
}

/** What a retry asks of the model after the reasons, when they name a refused number. Fixed text written by code. */
export const RETRY_ASK =
  "Write the whole reply again with each problem above fixed: remove every number named here, or replace it with the figure an accepted finding or a cited row gives, and change nothing else.";
/** What a retry asks when no number was refused (the schema, the disclaimer or the guard). */
export const RETRY_ASK_PLAIN = "Write the whole reply again with each problem above fixed, and change nothing else.";

/** The retry_reason the model gets: why the last reply failed, then what to do about it. */
export function retryMessage(reason: string): string {
  return `${reason} ${/ has the number /.test(reason) ? RETRY_ASK : RETRY_ASK_PLAIN}`;
}

export type ReviewCheck = ({ ok: true } | { ok: false; reason: string; /** True when the disclaimer line is the only problem, which write() fixes in code. */ only_disclaimer?: true }) & {
  /** Present, and true, only when guards.afterModel saw injection wording in the reply; write() then stores no memory. */
  injection_seen?: true;
};

/**
 * The three checks, in order: every number in the summary, the review and the memory note is allowed; the last
 * line of the review is the disclaimer; guards.afterModel passes. Every problem found goes into one reason, so a
 * retry can fix them all at once: each refused number with the words around it, and whether it was copied from a
 * gap the Analyst wrote or sits in a date range the run never had (no words are quoted when afterModel saw injection
 * wording). A same-month day range whose days are both dates of this run (as_of, a query's window, a cited row's
 * date) reads as a date, like "17 Sep"; the single-date patterns of numbersIn are unchanged, and nothing else is let
 * through.
 * Traced as agent "Writer", action "code_check". Injection wording the guard sees does not fail the check (the guard
 * does not block on it); it is passed on as injection_seen.
 */
export function checkReview(
  reply: WriterReply,
  allowed: {
    findings: readonly Finding[];
    results: ResultStore;
    memories: readonly Pick<RecalledMemory, "content">[];
    task: Task;
    counts?: RunCounts;
    question?: string;
    code_gaps?: readonly string[];
    /** Every gap the Writer was given; only used to say where a refused number was copied from. */
    gaps?: readonly string[];
    as_of?: string;
  },
  tracer?: Tracer,
  round = 0,
): ReviewCheck {
  const problems: string[] = [];
  const ids = Object.keys(allowed.results);
  const ignore = [...ids.map((id) => `[q:${id}]`), ...ids];
  // The question and the gaps code wrote are the only texts besides the data whose figures a review may repeat.
  // A gap the Analyst wrote is model text: its figures are not allowed unless a finding, a row or a memory holds them.
  const codeGaps = allowed.code_gaps ?? [];
  const quoted = [allowed.question ?? "", ...codeGaps].flatMap((text) => numbersIn(text, ignore));
  const candidates = [...allowedNumbers(allowed.findings, allowed.results, allowed.memories), ...countNumbers(allowed.counts), ...quoted];
  const dates = runDates(allowed.as_of, allowed.findings, allowed.results);
  // The guard runs first so that a reply with injection wording is never quoted back to the model in a reason.
  const guard = afterModel(AGENT, reply, { task: allowed.task }, tracer);
  const analystGaps = (allowed.gaps ?? []).filter((gap) => !codeGaps.includes(gap));
  for (const [field, text] of [
    ["summary", reply.summary],
    ["review_markdown", reply.review_markdown],
    ["memory_note", reply.memory_note],
  ] as const) {
    const masked = withoutRunRanges(text, dates);
    const seen = new Set<number>();
    for (const { value, index } of numberMatchesIn(masked.text, ignore)) {
      if (matches(value, candidates) || seen.has(value)) continue;
      seen.add(value);
      const range = masked.unproven.find((r) => index >= r.index && index < r.end);
      const gap = analystGaps.find((g) => matches(value, numbersIn(g, ignore)));
      const notes = [
        ...(guard.injection_seen ? [] : [`in "${around(text, index, String(value).length)}"`]),
        ...(range === undefined ? [] : [`"${range.text}" is a date range this run never had, so its day ${value} counts as a number`]),
        ...(gap === undefined ? [] : [`copied from a gap the Analyst wrote, whose figures count only when a finding, a cited row or a memory holds them`]),
      ];
      problems.push(`${field} has the number ${value}, which is in no accepted finding, cited row or recalled memory${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
    }
  }

  const last = reply.review_markdown.trimEnd().split("\n").at(-1)?.trim();
  const noDisclaimer = last !== DISCLAIMER;
  if (noDisclaimer) problems.push(`the last line of review_markdown must be "${DISCLAIMER}"`);

  if (!guard.ok) problems.push(guard.reason.replace(/\.$/, ""));
  const seen = guard.injection_seen ? { injection_seen: true as const } : {};

  const ok = problems.length === 0;
  const reason = ok ? "" : `${problems.join("; ")}.`;
  tracer?.log({
    agent_name: AGENT,
    action: "code_check",
    input_summary: capped(`review ${reply.review_markdown.length} chars, memory_note ${reply.memory_note.length} chars, ${candidates.length} allowed numbers`),
    output_summary: capped(ok ? "passed: every number is allowed, the last line is the disclaimer, the guard allows it" : `failed: ${reason}`),
    status: ok ? "ok" : "rejected",
    why: ok ? "every number is allowed, the last line is the disclaimer, the guard allows it" : reason,
    retry_count: round,
  });
  const onlyDisclaimer = noDisclaimer && problems.length === 1 && disclaimerFixable(reply.review_markdown) ? { only_disclaimer: true as const } : {};
  return ok ? { ok: true, ...seen } : { ok: false, reason, ...onlyDisclaimer, ...seen };
}

/** A line that is the disclaimer once Markdown marks (`*`, `_`, `>`, backticks) are stripped: "**...**", "> ...". */
export function isDisclaimerLine(line: string): boolean {
  return line.replace(/[*_>`]/g, "").trim() === DISCLAIMER;
}

/**
 * Whether code may put the disclaimer last: no line holds the sentence alongside other words (that line is model
 * text code won't edit), and the review does not end inside an unclosed code fence (the line would land in the code).
 */
function disclaimerFixable(review: string): boolean {
  const lines = review.split("\n");
  if (lines.some((line) => line.includes(DISCLAIMER) && !isDisclaimerLine(line))) return false;
  return lines.filter((line) => /^\s*(?:```|~~~)/.test(line)).length % 2 === 0;
}

/**
 * The review with the disclaimer as its last line: each disclaimer line (exact, or with only Markdown marks around
 * it; a misplaced or duplicate copy) is moved to the end as the exact sentence, or the sentence is added when there
 * is none. No other model text is removed or changed.
 */
export function withDisclaimerLast(review: string): string {
  const lines = review.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isDisclaimerLine(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    // The blank line that separated the moved copy goes with it, so no paragraph gap doubles.
    if (kept.length > 0 && kept[kept.length - 1].trim() === "" && lines[i + 1]?.trim() === "") i += 1;
  }
  const body = kept.join("\n").trim();
  return body.length === 0 ? DISCLAIMER : `${body}\n\n${DISCLAIMER}`;
}

// ---------------------------------------------------------------------------------------------------------------
// write

type Call = NonNullable<WriteDeps["complete"]>;

const EMPTY: WriterReply = { summary: "", review_markdown: "", memory_note: "" };

/** What the model sent, as far as it parses: a draft worth keeping even when the schema refused it. */
function draftOf(raw: unknown): WriterReply {
  if (!isRecord(raw)) return EMPTY;
  return { summary: str(raw.summary), review_markdown: str(raw.review_markdown), memory_note: str(raw.memory_note) };
}

/**
 * Writes the review for one run: the strong model with writer.md, the code check (a missing or misplaced disclaimer,
 * when it is the only problem, put last by code and checked again: disclaimer_added), one retry with retry_reason, then
 * ok false with the draft and the reason. On success the memory_note is stored through memory.remember (and so
 * guards.beforeRemember); a refused memory write leaves the review ok and names the reason in memory_reason. When
 * guards.afterModel saw injection wording in the accepted reply, remember is not called at all: the review stays
 * ok, memory_id is null and memory_reason says why, traced as action "memory_skipped".
 * Model errors from llm.ts and BudgetExhaustedError from the run state pass through.
 */
export async function write(input: WriteInput, arg: Tracer | WriteDeps): Promise<WriteOutcome> {
  const deps = depsOf(arg);
  const { tracer, run } = deps;
  const cfg = deps.config ?? run?.config ?? loadConfig(process.env, () => {});
  const sampleMode = deps.sampleMode ?? run?.sampleMode ?? cfg.sampleMode;
  const call: Call = deps.complete ?? completeModel;
  const round = deps.round ?? 0;
  const started = Date.now();
  const memories = input.memories ?? [];
  const inputSummary = capped(
    `task=${input.task} as_of=${input.as_of} ${input.findings.length} accepted findings, ${(input.gaps ?? []).length} gaps, ${memories.length} memories (${memories.filter((m) => m.tags.includes("correction")).length} corrections), escalation=${input.escalation ? input.escalation.rule : "none"}, declined_advice=${input.declined_advice === true}`,
  );
  const model: WriteOutcome["model"] = { model_id: "", source: "sample-model", usage: null, calls: 0, duration_ms: 0 };

  const accepted = async (review: WriterReply, attempts: number, injectionSeen: boolean): Promise<WriteOutcome> => {
    let memoryId: string | null = null;
    let memoryReason: string | null = null;
    if (injectionSeen) {
      memoryReason = "not stored: the guard saw injection wording in the reply";
      tracer.log({
        agent_name: AGENT,
        action: "memory_skipped",
        input_summary: capped(`memory_note ${review.memory_note.length} chars`),
        output_summary: memoryReason,
        status: "rejected",
        why: "guards.afterModel reported injection_seen on the reply; text that reads like an instruction never enters memory, where every later run would read it",
        model: model.model_id,
        retry_count: round,
      });
    } else if (deps.remember === false) {
      memoryReason = "not stored: the caller asked for no memory write";
    } else {
      // A review the owner stopped is not remembered: the run ends cancelled and writes no memory.
      deps.signal?.throwIfAborted();
      try {
        memoryId = await remember({ content: review.memory_note, task: input.task, asOf: input.as_of, runId: input.runId, tracer });
      } catch (error) {
        if (!(error instanceof MemoryBlockedError)) throw error;
        memoryReason = error.reason;
      }
    }
    const lines = review.review_markdown.split("\n");
    tracer.log({
      agent_name: AGENT,
      action: "write",
      input_summary: inputSummary,
      output_summary: capped(
        `${lines.length} lines, ${lines.filter((line) => line.startsWith("- ")).length} bullets, memory_note ${review.memory_note.length} chars; memory ${memoryId ?? `not stored (${memoryReason})`}; attempts=${attempts}`,
      ),
      target_agent: TARGET,
      status: "ok",
      model: model.model_id,
      retry_count: round,
      duration_ms: Date.now() - started,
    });
    return { ok: true, ...review, reason: null, memory_id: memoryId, memory_reason: memoryReason, injection_seen: injectionSeen, attempts, model };
  };

  const allowed = {
    findings: input.findings,
    results: input.results,
    memories,
    task: input.task,
    question: input.question,
    code_gaps: input.code_gaps ?? [],
    gaps: input.gaps ?? [],
    as_of: input.as_of,
    ...(input.counts === undefined ? {} : { counts: input.counts }),
  };
  let draft: WriterReply = EMPTY;
  let reason = "";
  let injectionSeen = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const user = writerInput(input, cfg, attempt === 1 ? null : retryMessage(reason));
    run?.beforeModelCall();
    let result: CompleteResult;
    try {
      result = await call({
        system: writerPromptVersion().text,
        prompt_hash: writerPromptVersion().prompt_hash,
        user: JSON.stringify(user),
        model: "strong",
        json: true,
        validate: writerReplyProblem,
        replyShape: WRITER_REPLY_SHAPE,
        agent: AGENT,
        tracer,
        config: cfg,
        sampleMode,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.roundDeadlineMs === undefined ? {} : { roundDeadlineMs: deps.roundDeadlineMs }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        ...(run === undefined ? {} : { modelCallsLeft: run.modelCallsLeft(), ...(run.tokensLeft === undefined ? {} : { tokensLeft: run.tokensLeft() }) }),
      });
    } catch (error) {
      // A failed call still counts: every request it made is a model call.
      run?.afterFailedModelCall(failedCallUsage(error));
      throw error;
    }
    run?.afterModelCall(result);
    model.calls += 1;
    model.model_id = result.model_id;
    model.source = result.source;
    model.duration_ms += result.duration_ms;
    if (result.fallback !== undefined) model.fallback = result.fallback;
    if (result.usage !== null) {
      model.usage = { tokens_in: (model.usage?.tokens_in ?? 0) + result.usage.tokens_in, tokens_out: (model.usage?.tokens_out ?? 0) + result.usage.tokens_out };
    }

    const parsed = writerReplySchema.safeParse(result.json ?? {});
    if (parsed.success) {
      draft = parsed.data;
      let check = checkReview(draft, allowed, tracer, round);
      // A missing or misplaced disclaimer, and nothing else wrong, is a fixed sentence: code puts it last and runs
      // every check again, instead of a slow retry. Any other problem (advice wording included) still retries.
      if (!check.ok && check.only_disclaimer === true) {
        const had = draft.review_markdown.split("\n").filter(isDisclaimerLine).length;
        draft = { ...draft, review_markdown: withDisclaimerLast(draft.review_markdown) };
        tracer.log({
          agent_name: AGENT,
          action: "disclaimer_added",
          input_summary: capped(`review ${parsed.data.review_markdown.length} chars, ${had} disclaimer lines, none last`),
          output_summary: had === 0 ? "the disclaimer added as the last line" : "the disclaimer moved to the last line",
          status: "ok",
          why: "the disclaimer line was the only problem; it is a fixed sentence, so code puts it last and checks the review again instead of asking the model",
          model: result.model_id,
          retry_count: round,
        });
        check = checkReview(draft, allowed, tracer, round);
      }
      injectionSeen = check.injection_seen === true;
      if (check.ok) return accepted(draft, attempt, injectionSeen);
      reason = check.reason;
    } else {
      draft = draftOf(result.json);
      const issue = parsed.error.issues[0];
      reason = `The reply does not match the Writer schema (${issue.path.join(".") || "reply"}: ${issue.message}).`;
      tracer.log({
        agent_name: AGENT,
        action: "code_check",
        input_summary: "the reply against the Writer schema",
        output_summary: capped(`failed: ${reason}`),
        status: "rejected",
        why: reason,
        model: result.model_id,
        retry_count: round,
      });
    }

    if (attempt < MAX_ATTEMPTS) {
      tracer.log({
        agent_name: AGENT,
        action: "retry",
        input_summary: inputSummary,
        output_summary: capped(`asking once more with retry_reason: ${retryMessage(reason)}`),
        status: "retry",
        why: reason,
        model: result.model_id,
        retry_count: round,
      });
    }
  }

  tracer.log({
    agent_name: AGENT,
    action: "write",
    input_summary: inputSummary,
    output_summary: capped(`the review failed the code check ${MAX_ATTEMPTS} times; the draft goes to the owner as needs_human: ${reason}`),
    target_agent: TARGET,
    status: "needs_human",
    why: reason,
    model: model.model_id,
    retry_count: round,
    duration_ms: Date.now() - started,
  });
  return { ok: false, ...draft, reason, memory_id: null, memory_reason: null, injection_seen: injectionSeen, attempts: MAX_ATTEMPTS, model };
}
