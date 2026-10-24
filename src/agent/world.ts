// The World Model: what the accepted runs established about the holdings, kept in the Meterless World Model
// reference (vendor/world-model, Apache-2.0, never edited). One WorldModel per data dir, stored in
// <data dir>/memory/world, so a TRADEFLOW_DATA_DIR fixture gets its own. Server only (node:fs): never import this
// from a client component or the edge runtime.
//
// recordRun writes only what the run's query results show (holdings, announcements, and facts such as weight_pct,
// latest_eps and dividend_owed_bdt), never model text. Every write carries its provenance: kind "api", the run's
// as_of, the run id and the run_query_id of the result it came from.
import path from "node:path";
import { WorldModel, externalId, type Entity, type Fact, type Provenance } from "../../vendor/world-model/src/index";
import { withLock } from "./concurrency";
import type { QueryResult, Row } from "./queries";
import { dataDir } from "@/lib/store";

const PORTFOLIO = "PORTFOLIO";

const instances = new Map<string, WorldModel>();

/** `<data dir>/memory/world`. The reference store keeps its file in `.world/tradeflow.json` under it. */
export function worldDir(): string {
  return path.join(dataDir(), "memory", "world");
}

export function openWorld(directory: string = worldDir()): WorldModel {
  let wm = instances.get(directory);
  if (wm === undefined) {
    wm = new WorldModel({ namespace: "tradeflow", storage: "local", directory });
    instances.set(directory, wm);
  }
  return wm;
}

export const holdingId = (symbol: string): string => externalId("holding", "dse", symbol);

// ---------------------------------------------------------------------------------------------------------------
// recordRun

export type RecordSummary = { entities: number; facts: number; relations: number; contexts: number; run_query_ids: string[] };

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What recordRun reads of an accepted finding: which results it cites, and about what. */
export type CitingFinding = { kind: string; subject: string; cites: readonly string[] };

/**
 * Records one accepted run from its result store (full rows, keyed by run_query_id). Holdings come from week_moves
 * rows and rule_findings position rows; announcements, latest_eps and dividend_owed_bdt are recorded only for those
 * holdings, or for holdings an earlier run recorded. With `findings` (the run's accepted findings), an announcement
 * is recorded only when a finding cites its result and names its symbol or id: the cited announcements. Returns
 * what was written and the run_query_ids it came from.
 */
async function recordRunUnlocked(a: { run_id: string; as_of: string; results: Record<string, QueryResult>; findings?: readonly CitingFinding[] }): Promise<RecordSummary> {
  const wm = openWorld();
  const at = `${a.as_of}T00:00:00Z`;
  const source = (runQueryId: string): Provenance => ({ kind: "api", by: "tradeflow-agent", at, runId: a.run_id, url: `run_query:${runQueryId}` });
  const results = Object.values(a.results);
  const used = new Set<string>();
  const summary: RecordSummary = { entities: 0, facts: 0, relations: 0, contexts: 0, run_query_ids: [] };

  // Holdings: one row per symbol, with the result it came from. week_moves wins over rule_findings for weight_pct.
  const holdings = new Map<string, { row: Row; runQueryId: string }>();
  for (const result of results.filter((r) => r.query_id === "week_moves")) {
    for (const row of result.rows) {
      const symbol = str(row.symbol);
      if (symbol !== "" && symbol !== PORTFOLIO && !holdings.has(symbol)) holdings.set(symbol, { row, runQueryId: result.run_query_id });
    }
  }
  for (const result of results.filter((r) => r.query_id === "rule_findings")) {
    for (const row of result.rows.filter((r) => r.row_type === "position")) {
      const symbol = str(row.symbol);
      if (symbol !== "" && !holdings.has(symbol)) holdings.set(symbol, { row, runQueryId: result.run_query_id });
    }
  }
  const isHolding = (symbol: string): boolean => holdings.has(symbol) || wm.view("graph").entity(holdingId(symbol)) !== undefined;
  const isCited = (runQueryId: string, row: Row): boolean =>
    a.findings === undefined || a.findings.some((f) => f.cites.includes(runQueryId) && (f.subject === str(row.symbol) || f.subject === str(row.id)));

  // The review week, from the first week_moves result (else the first result), as a context the facts sit in.
  const weekResult = results.find((r) => r.query_id === "week_moves") ?? results[0];
  let contextId: string | undefined;
  if (weekResult !== undefined) {
    const portfolioRow = weekResult.rows.find((row) => row.symbol === PORTFOLIO);
    const context = await wm.upsertContext({
      type: "review_week",
      externalKey: { system: "tradeflow", id: a.as_of },
      attrs: { as_of: a.as_of, from_date: str(portfolioRow?.from_date) || null, to_date: str(portfolioRow?.to_date) || a.as_of },
      source: source(weekResult.run_query_id),
    });
    contextId = context.id;
    summary.contexts += 1;
    used.add(weekResult.run_query_id);
  }

  const fact = async (symbol: string, predicate: string, value: unknown, runQueryId: string) => {
    await wm.assertFact({ about: holdingId(symbol), predicate, value, confidence: 1, context: contextId, source: source(runQueryId) });
    summary.facts += 1;
    used.add(runQueryId);
  };

  for (const [symbol, { row, runQueryId }] of holdings) {
    await wm.upsertEntity({
      type: "holding",
      externalKey: { system: "dse", id: symbol },
      name: symbol,
      attrs: { symbol, sector: str(row.sector) || null },
      source: source(runQueryId),
    });
    summary.entities += 1;
    used.add(runQueryId);
    const weight = num(row.weight_pct);
    if (weight !== null) await fact(symbol, "weight_pct", weight, runQueryId);
  }

  // Announcements of a holding, each related to it by "mentions".
  for (const result of results.filter((r) => r.query_id === "announcements_between")) {
    for (const row of result.rows) {
      const symbol = str(row.symbol);
      const id = str(row.id);
      if (id === "" || !isHolding(symbol) || !isCited(result.run_query_id, row)) continue;
      const announcement = await wm.upsertEntity({
        type: "announcement",
        externalKey: { system: "dse", id },
        attrs: { announcement_id: id, symbol, title: str(row.title), category: str(row.category), published_on: str(row.published_on), price_sensitive: row.price_sensitive === true },
        source: source(result.run_query_id),
      });
      summary.entities += 1;
      await wm.relate({ from: announcement.id, type: "mentions", to: holdingId(symbol), source: source(result.run_query_id) });
      summary.relations += 1;
      used.add(result.run_query_id);
    }
  }

  // latest_eps: the row marked is_latest for each held symbol.
  for (const result of results.filter((r) => r.query_id === "fundamentals_latest")) {
    for (const row of result.rows.filter((r) => r.is_latest === true)) {
      const symbol = str(row.symbol);
      const eps = num(row.eps_bdt);
      if (eps !== null && isHolding(symbol)) await fact(symbol, "latest_eps", eps, result.run_query_id);
    }
  }

  // dividend_owed_bdt: the cash dividends not yet paid, summed per held symbol.
  for (const result of results.filter((r) => r.query_id === "dividends_between")) {
    const owed = new Map<string, number>();
    for (const row of result.rows) {
      const symbol = str(row.symbol);
      const amount = num(row.amount_bdt);
      if (row.paid === true || row.kind !== "cash_dividend" || amount === null || !isHolding(symbol)) continue;
      owed.set(symbol, (owed.get(symbol) ?? 0) + amount);
    }
    for (const [symbol, amount] of owed) await fact(symbol, "dividend_owed_bdt", Math.round(amount * 100) / 100, result.run_query_id);
  }

  summary.run_query_ids = [...used];
  return summary;
}

/**
 * recordRun, one at a time per data dir: it awaits between reading the World Model (isHolding) and writing it, and
 * the briefing's children record at the same time. The docs above describe it.
 */
export const recordRun = (...args: Parameters<typeof recordRunUnlocked>): ReturnType<typeof recordRunUnlocked> => withLock(`world:${worldDir()}`, () => recordRunUnlocked(...args));

// ---------------------------------------------------------------------------------------------------------------
// about

// Kept small: it goes into the Planner's and the Analyst's prompts for every holding.
export type WorldFact = { predicate: string; value: unknown; as_of: string; url: string | null };
export type WorldAnnouncement = { announcement_id: string; title: string; published_on: string; url: string | null };
export type WorldAbout = { symbol: string; facts: WorldFact[]; announcements: WorldAnnouncement[] };

/**
 * The World facts about() returns, in total: each run adds facts to the World Model, and they go into every
 * Analyst prompt, so the total is bounded by size. The newest facts that fit are kept.
 */
export const MAX_FACT_CHARS = 4000;

/** The newest entries whose JSON fits in maxChars in total, grouped by symbol, in their original order. */
export function newestWithin<T extends { as_of: string }>(entries: readonly { symbol: string; fact: T }[], maxChars: number): Map<string, T[]> {
  const ranked = [...entries].sort((x, y) => y.fact.as_of.localeCompare(x.fact.as_of));
  const kept = new Set<{ symbol: string; fact: T }>();
  let used = 0;
  for (const entry of ranked) {
    const size = JSON.stringify(entry.fact).length;
    if (used + size > maxChars) continue;
    used += size;
    kept.add(entry);
  }
  const out = new Map<string, T[]>();
  for (const entry of entries) {
    if (kept.has(entry)) out.set(entry.symbol, [...(out.get(entry.symbol) ?? []), entry.fact]);
  }
  return out;
}

/** The latest announcements per symbol that about() returns; the World Model keeps them all. */
export const MAX_ANNOUNCEMENTS_PER_SYMBOL = 3;

const factOf = (f: Fact): WorldFact => ({ predicate: f.predicate, value: f.value, as_of: f.source.at.slice(0, 10), url: f.source.url ?? null });
const announcementOf = (e: Entity): WorldAnnouncement => ({
  announcement_id: str(e.attrs.announcement_id),
  title: str(e.attrs.title),
  published_on: str(e.attrs.published_on),
  url: e.source.url ?? null,
});

/**
 * What the World Model holds about each symbol: its current facts (view("facts").about, without the facts a later
 * one superseded) and the latest MAX_ANNOUNCEMENTS_PER_SYMBOL announcements that mention it
 * (view("graph").incoming via "mentions"), each with its source url "run_query:<run_query_id>". A symbol nothing was
 * recorded for is left out.
 */
export function about(symbols: readonly string[]): WorldAbout[] {
  const wm = openWorld();
  const unique = [...new Set(symbols)];
  const allFacts = unique.flatMap((symbol) =>
    wm
      .view("facts")
      .about(holdingId(symbol))
      .filter((f) => f.supersededBy === undefined)
      .map((f) => ({ symbol, fact: factOf(f) })),
  );
  const keptFacts = newestWithin(allFacts, MAX_FACT_CHARS);
  const out: WorldAbout[] = [];
  for (const symbol of unique) {
    const id = holdingId(symbol);
    const facts = keptFacts.get(symbol) ?? [];
    const announcements = wm
      .view("graph")
      .incoming(id, { via: "mentions" })
      .map(announcementOf)
      .sort((x, y) => y.published_on.localeCompare(x.published_on))
      .slice(0, MAX_ANNOUNCEMENTS_PER_SYMBOL);
    if (facts.length === 0 && announcements.length === 0) continue;
    out.push({ symbol, facts, announcements });
  }
  return out;
}
