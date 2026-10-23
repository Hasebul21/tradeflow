// The owner's memory, kept in the Meterless H-MEM engine (vendor/hmem, Apache-2.0, never edited). One HMEM
// instance per data dir, so a TRADEFLOW_DATA_DIR fixture gets its own state.json and ledger.jsonl. Server only
// (node:fs): never import this from a client component or the edge runtime.
//
// H-MEM's reference embedder is a hash and its store is a JSON file. Recall is lexical and tag-based, not semantic.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HMEM } from "../../vendor/hmem/src/index";
import type { MemoryRecord, MemoryType } from "../../vendor/hmem/src/types";
import { loadConfig, type Config } from "./config";
import { beforeRemember } from "./guards";
import { complete, failedCallUsage } from "./llm";
import type { Tracer } from "./trace";
import type { JournalEntry, Profile, Rules } from "@/lib/data-types";
import type { TransactionRow } from "@/lib/portfolio";
import { dataDir, readJson } from "@/lib/store";

/** What a model may see of a memory. `relevance` is null for a memory taken by tag. */
export type RecalledMemory = { id: string; tags: string[]; content: string; relevance: number | null };

/** The run's model usage; the miner adds to it, and the orchestrator sums it into the run's usage. */
export type MinerUsage = { model_calls: number; tokens_in: number; tokens_out: number };

const QUERY_TOP_N = 5;
const QUERY_THRESHOLD = 0.35;
const DATE_TAG = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------------------------------------------
// The miner: H-MEM calls minerFn(prompt) for hmem.mine(). The tracer and the usage belong to the run that asks, so
// they travel in an AsyncLocalStorage store instead of a module-level variable.

/** The run that asks H-MEM to mine: its tracer and usage, and optionally its sample mode and config. */
export type MinerRun = { tracer: Tracer; usage: MinerUsage; sampleMode?: boolean; config?: Config };

const minerStore = new AsyncLocalStorage<MinerRun>();

/** Runs `fn` with the run's tracer and usage, so every model call H-MEM makes inside it is traced and counted. */
export function withMiner<T>(run: MinerRun, fn: () => Promise<T>): Promise<T> {
  return minerStore.run(run, fn);
}

async function minerFn(prompt: string): Promise<string> {
  const run = minerStore.getStore();
  if (run === undefined) throw new Error("The memory miner needs a run: call it inside withMiner({ tracer, usage }, ...).");
  const config = run.config ?? loadConfig(process.env, () => {});
  if (run.usage.model_calls >= config.MAX_MODEL_CALLS) {
    throw new Error(`The memory miner would pass MAX_MODEL_CALLS (${config.MAX_MODEL_CALLS}).`);
  }
  // Every request counts as a model call, a failed one and each retry included.
  const modelCallsLeft = config.MAX_MODEL_CALLS - run.usage.model_calls;
  let result: Awaited<ReturnType<typeof complete>>;
  try {
    result = await complete({ system: "", user: prompt, model: "fast", agent: "Memory", tracer: run.tracer, config, modelCallsLeft, ...(run.sampleMode === undefined ? {} : { sampleMode: run.sampleMode }) });
  } catch (error) {
    const spent = failedCallUsage(error);
    run.usage.model_calls += spent.model_calls;
    run.usage.tokens_in += spent.tokens_in;
    run.usage.tokens_out += spent.tokens_out;
    throw error;
  }
  run.usage.model_calls += result.model_calls ?? 1;
  run.usage.tokens_in += result.usage?.tokens_in ?? 0;
  run.usage.tokens_out += result.usage?.tokens_out ?? 0;
  return result.text ?? "";
}

// ---------------------------------------------------------------------------------------------------------------
// One instance per data dir.

const instances = new Map<string, HMEM>();

/** `<data dir>/memory`: state.json and ledger.jsonl. */
export function memoryDir(): string {
  return path.join(dataDir(), "memory");
}

export function openMemory(dir: string = memoryDir()): HMEM {
  let hmem = instances.get(dir);
  if (hmem === undefined) {
    hmem = new HMEM({ persistDir: dir, minerFn });
    instances.set(dir, hmem);
  }
  return hmem;
}

// ---------------------------------------------------------------------------------------------------------------
// recall

const dateTagOf = (tags: string[]): string | undefined => tags.find((tag) => DATE_TAG.test(tag));
/** "mem-12" is the 12th write; a higher number was written later. */
const writeOrder = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1));
const idList = (memories: { id: string }[]): string => (memories.length === 0 ? "none" : memories.map((m) => m.id).join(","));

function assertYmd(value: string, name: string): void {
  if (!DATE_TAG.test(value)) throw new Error(`${name} must be a yyyy-mm-dd date, got ${JSON.stringify(value)}.`);
}

/**
 * A review is visible only from the day after its date tag; any other memory with a date tag is visible on that day
 * and after. A memory with no date tag (a rule, the profile) is always visible.
 */
function visibleOn(memory: MemoryRecord, asOf: string): boolean {
  const date = dateTagOf(memory.tags);
  if (date === undefined) return true;
  return memory.tags.includes("review") ? date < asOf : date <= asOf;
}

const toRecalled = (memory: MemoryRecord, relevance: number | null): RecalledMemory => ({
  id: memory.id,
  tags: [...memory.tags],
  content: memory.content,
  relevance,
});

/**
 * First by tag and without a threshold: every correction, then the review with the latest date tag before `asOf`.
 * Then the H-MEM query fills what room is left up to MAX_MEMORIES. Traces one Memory.recall line.
 */
export async function recall(question: string, asOf: string, tracer: Tracer): Promise<RecalledMemory[]> {
  assertYmd(asOf, "asOf");
  const started = Date.now();
  const hmem = openMemory();
  const max = loadConfig(process.env, () => {}).MAX_MEMORIES;

  const visible = hmem.store.all().filter((memory) => visibleOn(memory, asOf));
  const corrections = visible
    .filter((memory) => memory.tags.includes("correction"))
    .sort((a, b) => writeOrder(b.id) - writeOrder(a.id));
  const latestReview = visible
    .filter((memory) => memory.tags.includes("review") && !memory.tags.includes("correction"))
    .map((memory) => ({ memory, date: dateTagOf(memory.tags) }))
    .filter((entry): entry is { memory: MemoryRecord; date: string } => entry.date !== undefined)
    .sort((a, b) => b.date.localeCompare(a.date) || writeOrder(b.memory.id) - writeOrder(a.memory.id))[0]?.memory;

  const byTag = [...corrections, ...(latestReview === undefined ? [] : [latestReview])].slice(0, max);
  const taken = new Set(byTag.map((memory) => memory.id));

  const result = hmem.query(question, { topN: QUERY_TOP_N, threshold: QUERY_THRESHOLD });
  const byQuery = result.memories
    .filter((hit) => !taken.has(hit.memory.id) && visibleOn(hit.memory, asOf))
    .slice(0, Math.max(0, max - byTag.length));

  const recalled = [
    ...byTag.map((memory) => toRecalled(memory, null)),
    ...byQuery.map((hit) => toRecalled(hit.memory, Number(hit.relevance.toFixed(4)))),
  ];
  const correctionIds = byTag.filter((memory) => memory.tags.includes("correction"));
  tracer.log({
    agent_name: "Memory",
    action: "recall",
    input_summary: `question of ${question.length} chars, as_of ${asOf}`,
    output_summary: `by_tag=${idList(byTag)}; by_query=${idList(byQuery.map((hit) => hit.memory))}; corrections=${idList(correctionIds)}`,
    status: "ok",
    retrievalReason: result.trace.retrievalReason,
    strategy: result.trace.strategy,
    duration_ms: Date.now() - started,
  });
  return recalled;
}

// ---------------------------------------------------------------------------------------------------------------
// remember

/** The last line of memory/ledger.jsonl: the entry H-MEM wrote for the memory that was just added. */
function lastLedgerEntry(): { memoryId: string; action: string; actor: string } | undefined {
  try {
    const lines = readFileSync(path.join(memoryDir(), "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = lines.at(-1);
    return last === undefined ? undefined : (JSON.parse(last) as { memoryId: string; action: string; actor: string });
  } catch {
    return undefined;
  }
}

/** guards.beforeRemember refused a memory write; nothing was stored. */
export class MemoryBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MemoryBlockedError";
  }
}

/**
 * Stores an accepted review as a "general" memory tagged review, the task, the as_of date and the run. Returns its id.
 * guards.beforeRemember runs first: a refused write throws MemoryBlockedError and stores nothing. */
export async function remember(a: { content: string; task: string; asOf: string; runId: string; tracer: Tracer }): Promise<string> {
  assertYmd(a.asOf, "asOf");
  const guard = beforeRemember({ kind: "review", text: a.content }, a.tracer);
  if (!guard.ok) throw new MemoryBlockedError(guard.reason);
  const started = Date.now();
  const tags = ["review", a.task, a.asOf, `run:${a.runId}`];
  const record = openMemory().add({ content: a.content, type: "general", source: "agent:writer", tags });
  a.tracer.log({
    agent_name: "Memory",
    action: "remember",
    input_summary: `${a.task} review for ${a.asOf}, ${a.content.length} chars`,
    output_summary: `memoryId=${record.id}; tags=${tags.join(",")}`,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  const entry = lastLedgerEntry();
  a.tracer.log({
    agent_name: "Memory",
    action: "ledger",
    input_summary: `last line of memory/ledger.jsonl after ${record.id}`,
    output_summary: entry === undefined ? "no ledger entry found" : `memoryId=${entry.memoryId}; action=${entry.action}; actor=${entry.actor}`,
    status: entry === undefined ? "error" : "ok",
  });
  return record.id;
}

/**
 * Stores an owner decision, such as an approved reconciliation fix, as a "general" memory tagged decision, the
 * task, the issue and the review it approves. Returns its id. guards.beforeRemember runs first with kind "decision":
 * a refused write throws MemoryBlockedError and stores nothing.
 */
export async function rememberDecision(a: { content: string; task: string; issueId: string; reviewRunId: string; tracer: Tracer }): Promise<string> {
  const guard = beforeRemember({ kind: "decision", text: a.content }, a.tracer);
  if (!guard.ok) throw new MemoryBlockedError(guard.reason);
  const started = Date.now();
  const tags = ["decision", a.task, a.issueId, `run:${a.reviewRunId}`];
  const record = openMemory().add({ content: a.content, type: "general", source: "owner:decision", tags });
  a.tracer.log({
    agent_name: "Memory",
    action: "remember",
    input_summary: `owner decision on ${a.issueId}, ${a.content.length} chars`,
    output_summary: `memoryId=${record.id}; tags=${tags.join(",")}`,
    status: "ok",
    duration_ms: Date.now() - started,
  });
  return record.id;
}

// ---------------------------------------------------------------------------------------------------------------
// seedOwnerContext

type Seed = { source: string; content: string; type: MemoryType; tags: string[] };

function seedsFrom(rules: Rules | null, profile: Profile | null, journal: JournalEntry[], transactions: TransactionRow[]): Seed[] {
  const seeds: Seed[] = [];
  if (rules !== null) {
    seeds.push({
      source: "seed:rules:position_limit",
      content: `Position limit: no single stock above ${rules.max_position_weight_pct}% of the portfolio's market value.`,
      type: "preference",
      tags: ["rule", "position_limit"],
    });
    for (const target of rules.sector_targets) {
      seeds.push({
        source: `seed:rules:sector:${target.sector}`,
        content: `Sector target: ${target.sector} at ${target.target_percent}% of the portfolio, flagged when more than ${rules.sector_tolerance_pct} points away.`,
        type: "preference",
        tags: ["rule", "sector_target", target.sector.toLowerCase()],
      });
    }
    for (const plan of rules.trade_plans) {
      const date = plan.created_at.slice(0, 10);
      const quantity = plan.quantity_shares === null ? "an open number of" : String(plan.quantity_shares);
      const note = plan.note === null ? "" : ` Note: ${plan.note}.`;
      seeds.push({
        source: `seed:rules:plan:${plan.id}`,
        content: `Trade plan ${plan.id}: ${plan.side} ${quantity} shares of ${plan.symbol} at ${plan.target_price} BDT, set on ${date}.${note} ${plan.executed ? "Executed." : "Not executed."}`,
        type: "preference",
        tags: ["rule", "trade_plan", plan.symbol, date],
      });
    }
  }
  if (profile !== null) {
    seeds.push({
      source: "seed:profile:review_day",
      content: `The owner reviews the portfolio on ${profile.review_day}.`,
      type: "preference",
      tags: ["profile", "review_day"],
    });
    seeds.push({
      source: "seed:profile:goal",
      content: `Investment goal: ${profile.investment_goal}`,
      type: "preference",
      tags: ["profile", "goal"],
    });
    if (profile.excluded_sectors.length > 0) {
      seeds.push({
        source: "seed:profile:excluded_sectors",
        content: `Excluded sectors the owner does not want to own: ${profile.excluded_sectors.join(", ")}.`,
        type: "preference",
        tags: ["profile", "excluded_sectors"],
      });
    }
  }
  const symbolOf = new Map(transactions.map((transaction) => [transaction.id, transaction.symbol]));
  for (const entry of journal) {
    const symbol = symbolOf.get(entry.transaction_id);
    const date = entry.created_at.slice(0, 10);
    const exit = entry.exit_condition === null ? "No exit condition recorded." : `Exit condition: ${entry.exit_condition}`;
    seeds.push({
      source: `seed:journal:${entry.id}`,
      content: `Thesis ${entry.id}${symbol === undefined ? "" : ` for ${symbol}`}, written ${date}, horizon ${entry.horizon}: ${entry.thesis} ${exit}`,
      type: "personal",
      tags: ["thesis", ...(symbol === undefined ? [] : [symbol]), date, ...entry.tags],
    });
  }
  return seeds;
}

/**
 * Adds the owner's rules, profile and journal theses as long-term memories, once: a seed whose source is already
 * in the store is skipped. The one exception to AGENTS.md rule 6: it skips guards.beforeRemember.
 */
export async function seedOwnerContext(tracer?: Tracer): Promise<{ added: number; already_present: number }> {
  const started = Date.now();
  const [rules, profile, journal, transactions] = await Promise.all([
    readJson<Rules | null>("rules", null),
    readJson<Profile | null>("profile", null),
    readJson<JournalEntry[]>("journal", []),
    readJson<TransactionRow[]>("transactions", []),
  ]);
  const hmem = openMemory();
  const present = new Set(hmem.store.all().map((memory) => memory.source));
  let added = 0;
  let alreadyPresent = 0;
  for (const seed of seedsFrom(rules, profile, journal, transactions)) {
    if (present.has(seed.source)) {
      alreadyPresent += 1;
      continue;
    }
    hmem.add({
      content: seed.content,
      type: seed.type,
      layer: "long_term",
      tags: seed.tags,
      confidence: 1,
      source: seed.source,
      provenance: { origin: "document", learnedAt: hmem.clock(), label: seed.source },
    });
    added += 1;
  }
  tracer?.log({
    agent_name: "Memory",
    action: "seed",
    input_summary: "rules, profile and journal from the data dir",
    output_summary: `added=${added}; already_present=${alreadyPresent}`,
    status: "ok",
    duration_ms: Date.now() - started,
  });
  return { added, already_present: alreadyPresent };
}

// ---------------------------------------------------------------------------------------------------------------
// learnCorrection

export type LearnResult =
  | { ok: true; as_of: string; memory_ids_added: string[]; wrong_memory_ids: string[] }
  | { ok: false; error: { type: "InvalidInput"; message: string; recoverable: false } };

const refused = (message: string): LearnResult => ({ ok: false, error: { type: "InvalidInput", message, recoverable: false } });

/**
 * Learns from the owner's correction to a review. The review is the memory tagged "review" and "run:<review_run_id>";
 * its date tag (remember writes exactly one) becomes the correction's. The owner's text goes through
 * guards.beforeRemember (kind "correction") before anything is written, then through hmem.mine("user_correction"),
 * whose model call runs inside the caller's withMiner. Each mined record is checked again and tagged "correction" and
 * the date with hmem.store.update; one the guard refuses is deleted. When mining keeps nothing, the text is added
 * as a "preference" memory from "owner:correction". Each id in wrong_memory_ids gets hmem.feedback(id, "wrong").
 * Traces one Memory "learn" line per memory written and one Memory "feedback" line per wrong id. The text is
 * stored as the owner's words, never as an instruction to the agents.
 */
export async function learnCorrection(a: { review_run_id: string; text: string; wrong_memory_ids?: readonly string[]; tracer: Tracer }): Promise<LearnResult> {
  const hmem = openMemory();
  const reviewRunId = typeof a.review_run_id === "string" ? a.review_run_id.trim() : "";
  const text = typeof a.text === "string" ? a.text.trim() : "";
  if (reviewRunId === "") return refused("review_run_id is required: the run id of the review this corrects.");
  if (text === "") return refused("text is required: the correction in the owner's words.");

  const review = hmem.store.all().find((memory) => memory.tags.includes("review") && memory.tags.includes(`run:${reviewRunId}`));
  const asOf = review === undefined ? undefined : dateTagOf(review.tags);
  if (review === undefined || asOf === undefined) {
    return refused(`No remembered review has review_run_id ${JSON.stringify(reviewRunId)}: only a review that passed the Evaluator is remembered.`);
  }
  const wrong = [...new Set(a.wrong_memory_ids ?? [])];
  const unknown = wrong.filter((id) => typeof id !== "string" || hmem.store.get(id) === undefined);
  if (unknown.length > 0) return refused(`wrong_memory_ids holds ids no memory has: ${unknown.map((id) => JSON.stringify(id)).join(", ")}.`);

  const guard = beforeRemember({ kind: "correction", text }, a.tracer);
  if (!guard.ok) return refused(guard.reason);

  const learned = (id: string, how: string, tags: string[], started: number) =>
    a.tracer.log({
      agent_name: "Memory",
      action: "learn",
      input_summary: `correction to ${reviewRunId} (${asOf}), ${text.length} chars`,
      output_summary: `memoryId=${id}; ${how}; tags=${tags.join(",")}`,
      status: "ok",
      duration_ms: Date.now() - started,
    });

  const added: string[] = [];
  let started = Date.now();
  const mined = await hmem.mine("user_correction", text);
  for (const record of mined) {
    const check = beforeRemember({ kind: "correction", text: record.content }, a.tracer);
    if (!check.ok) {
      hmem.store.delete(record.id, `guards.beforeRemember: ${check.reason}`);
      a.tracer.log({
        agent_name: "Memory",
        action: "learn",
        input_summary: `correction to ${reviewRunId} (${asOf}), mined record ${record.id}`,
        output_summary: `memoryId=${record.id}; deleted: the guard refused it`,
        status: "blocked",
        why: check.reason,
      });
      continue;
    }
    const tags = [...record.tags, "correction", asOf];
    hmem.store.update(record.id, { tags });
    added.push(record.id);
    learned(record.id, "mined", tags, started);
    started = Date.now();
  }
  if (added.length === 0) {
    const tags = ["correction", asOf];
    const record = hmem.add({ content: text, type: "preference", source: "owner:correction", tags });
    added.push(record.id);
    learned(record.id, "added as the owner's words (mining kept nothing)", tags, started);
  }

  for (const id of wrong) {
    hmem.feedback(id, "wrong");
    a.tracer.log({
      agent_name: "Memory",
      action: "feedback",
      input_summary: `correction to ${reviewRunId} marks ${id} wrong`,
      output_summary: `hmem.feedback(${id}, "wrong")`,
      status: "ok",
    });
  }
  return { ok: true, as_of: asOf, memory_ids_added: added, wrong_memory_ids: wrong };
}
