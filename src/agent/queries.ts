// The named-query registry: the only way an agent reads the ledger. Each query calls the same src/lib
// function as its API route, so an answer matches what the page shows. Server only: loadQueryData reads data/.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { attributionAsOf, sectorMovesAsOf } from "@/lib/market-views";
import { filterAnnouncements, loadAnnouncements, publishedYmd, sortAnnouncementsByLatest } from "@/lib/announcements";
import { bonusTransactions, dividendsFor, sharesHeldOn } from "@/lib/corporate-actions";
import type { Announcement, Fundamental, JournalEntry, SectorIndexBar } from "@/lib/data-types";
import { loadFundamentals, summariseFundamentals } from "@/lib/fundamentals";
import { journalForSymbol, loadJournal } from "@/lib/journal";
import { barsBySymbol, latestQuote } from "@/lib/market/quotes";
import { loadSectorIndexBars } from "@/lib/market/sector-index";
import { addDseTradingDays, dhakaToday, parseYmd } from "@/lib/market/trading-calendar";
import {
  buildPortfolioView,
  dataUpTo,
  loadPortfolioData,
  resolveAsOf,
  withBonusShares,
  type PortfolioData,
} from "@/lib/portfolio-view";
import { reconcile } from "@/lib/reconcile";
import { positionWeights, sectorWeights, type RuleFinding } from "@/lib/rules";
import { sectorMatchKey } from "@/lib/sector-targets";
import { loadBankDeposits, loadBrokerStatement, type BankDepositRow, type BrokerStatementRow } from "@/lib/sources";
import { normalizeSymbol } from "@/lib/symbol";
import { previewTrade } from "@/lib/what-if";
import { roundBdt } from "@/lib/portfolio";

export type Row = Record<string, unknown>;

export type QueryId =
  | "week_moves"
  | "sector_vs_stock"
  | "announcements_between"
  | "fundamentals_latest"
  | "dividends_between"
  | "journal_for_symbol"
  | "rule_findings"
  | "what_if"
  | "reconciliation";

export type QuerySource = "local" | "zetaris" | "local-fallback";

export type QueryResult = {
  query_id: QueryId;
  /** One per execution; findings cite it as the evidence for a number. */
  run_query_id: string;
  params: Record<string, unknown>;
  rows: Row[];
  source: QuerySource;
};

/** Everything the local queries read, loaded once per run. */
export type QueryData = {
  portfolio: PortfolioData;
  sectorBars: SectorIndexBar[];
  announcements: Announcement[];
  fundamentals: Fundamental[];
  journal: JournalEntry[];
  broker: BrokerStatementRow[];
  bank: BankDepositRow[];
};

export type QueryErrorType = "unknown_query" | "invalid_params" | "invalid_date" | "unknown_symbol" | "no_price" | "rejected";

/** A query that cannot run: a bad parameter, a date outside the data, an unknown symbol. The caller decides if it is recoverable. */
export class QueryError extends Error {
  constructor(
    readonly type: QueryErrorType,
    message: string,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export type NamedQuery<P = unknown> = {
  id: QueryId;
  /** Written for the Planner: what question it answers and when to use it. */
  description: string;
  params: z.ZodType<P>;
  local(p: P, d: QueryData): Row[];
};

const PORTFOLIO = "PORTFOLIO";
const DEFAULT_SESSIONS = 5;

// ---------------------------------------------------------------------------------------------- params

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as yyyy-mm-dd")
  .refine((s) => parseYmd(s) !== null, "must be a real calendar date");

const asOfDate = ymd.describe("The review date, yyyy-mm-dd. A Friday or Saturday becomes the Thursday before.");
const symbolParam = z.string().trim().min(1).describe("A DSE trading code such as GP or BXPHARMA.");
const sessions = z.number().int().min(1).max(120).default(DEFAULT_SESSIONS).describe("Trading sessions in the window; 5 is one week.");

const between = z
  .object({
    from: ymd.describe("First day, yyyy-mm-dd, inclusive."),
    to: ymd.describe("Last day, yyyy-mm-dd, inclusive."),
  })
  .refine((p) => p.from <= p.to, { message: "from must not be after to", path: ["to"] });

const weekMovesParams = z.object({ as_of: asOfDate, sessions });
const sectorVsStockParams = z.object({ as_of: asOfDate, sessions });
const announcementsParams = z
  .object({
    from: ymd.describe("First day, yyyy-mm-dd, inclusive."),
    to: ymd.describe("Last day, yyyy-mm-dd, inclusive."),
    symbol: symbolParam.optional().describe("Only this company; leave out for every company."),
  })
  .refine((p) => p.from <= p.to, { message: "from must not be after to", path: ["to"] });
const fundamentalsParams = z.object({ symbol: symbolParam, as_of: asOfDate });
const dividendsParams = between;
const journalParams = z.object({
  symbol: symbolParam.optional().describe("Only this company's trades; leave out for every journal entry."),
  as_of: asOfDate,
});
const ruleFindingsParams = z.object({ as_of: asOfDate });
const whatIfParams = z.object({
  symbol: symbolParam,
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive().describe("Whole shares."),
  price: z.number().positive().optional().describe("Taka per share; defaults to the close on as_of."),
  as_of: asOfDate,
});
const reconciliationParams = z.object({});

// ---------------------------------------------------------------------------------------------- helpers

const r2 = (n: number | null | undefined): number | null => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

function resolveDate(d: QueryData, requested: string): string {
  const r = resolveAsOf(d.portfolio.bars, requested);
  if (!r.ok) throw new QueryError("invalid_date", r.error);
  return r.asOf;
}

/** One flat row per rule finding, with the same keys whatever its kind. */
function findingRow(f: RuleFinding): Row {
  if (f.kind === "max_position_weight") {
    return { kind: f.kind, subject: f.symbol, actual_pct: f.weightPct, limit_pct: f.limitPct, delta_pct: r2(f.weightPct - f.limitPct), message: f.message };
  }
  if (f.kind === "sector_target") {
    return { kind: f.kind, subject: f.sector, actual_pct: f.actualPct, target_pct: f.targetPct, delta_pct: f.deltaPct, message: f.message };
  }
  return { kind: f.kind, subject: f.planId, symbol: f.symbol, side: f.side, target_price: f.targetPrice, ltp: f.ltp, message: f.message };
}

// ---------------------------------------------------------------------------------------------- queries

const weekMoves: NamedQuery<z.output<typeof weekMovesParams>> = {
  id: "week_moves",
  description:
    "Per holding, the move over the last sessions against its sector index and DSEX, with a PORTFOLIO row first (portfolio change against DSEX); use first for any question about what moved or why the week was good or bad.",
  params: weekMovesParams,
  local(p, d) {
    const asOf = resolveDate(d, p.as_of);
    const att = attributionAsOf(d.portfolio, d.sectorBars, asOf, p.sessions);
    const weights = new Map(buildPortfolioView(d.portfolio, asOf).holdings.map((h) => [h.symbol, h.weightPct]));
    const portfolio: Row = {
      symbol: PORTFOLIO,
      from_date: att.fromDate,
      to_date: att.toDate,
      change_pct: r2(att.changePct),
      change_bdt: att.changeBdt,
      index_change_pct: r2(att.indexChangePct),
      vs_index_pts: r2(att.differencePts),
    };
    const holdings = [...att.holdings]
      .sort((a, b) => Math.abs(b.contributionBdt) - Math.abs(a.contributionBdt) || a.symbol.localeCompare(b.symbol))
      .map(
        (h): Row => ({
          symbol: h.symbol,
          sector: h.sector,
          shares: h.shares,
          from_close: h.fromClose,
          to_close: h.toClose,
          change_pct: r2(h.changePct),
          contribution_bdt: h.contributionBdt,
          contribution_pts: r2(h.contributionPts),
          sector_change_pct: r2(h.sectorChangePct),
          index_change_pct: r2(h.indexChangePct),
          vs_sector_pts: r2(h.versusSectorPts),
          comparison: h.comparison,
          weight_pct: r2(weights.get(h.symbol)),
        }),
      );
    return [portfolio, ...holdings];
  },
};

const sectorVsStock: NamedQuery<z.output<typeof sectorVsStockParams>> = {
  id: "sector_vs_stock",
  description:
    "Per sector, its index move against DSEX and what the portfolio's holdings in it added or took in taka and points; use to tell a sector-wide move from a company-specific one.",
  params: sectorVsStockParams,
  local(p, d) {
    const asOf = resolveDate(d, p.as_of);
    const moves = sectorMovesAsOf(d.portfolio, d.sectorBars, asOf, p.sessions);
    const att = attributionAsOf(d.portfolio, d.sectorBars, asOf, p.sessions);
    const held = new Map(att.sectors.map((s) => [sectorMatchKey(s.sector), s]));
    return moves.sectors.map((s): Row => {
      const c = held.get(sectorMatchKey(s.sector));
      return {
        sector: s.sector,
        from_date: s.fromDate,
        to_date: s.toDate,
        close: s.close,
        change_pct: r2(s.changePct),
        index_change_pct: r2(moves.dsex?.changePct),
        vs_index_pts: moves.dsex ? r2(s.changePct - moves.dsex.changePct) : null,
        contribution_bdt: c?.contributionBdt ?? 0,
        contribution_pts: r2(c?.contributionPts ?? 0),
      };
    });
  },
};

const announcementsBetween: NamedQuery<z.output<typeof announcementsParams>> = {
  id: "announcements_between",
  description:
    "Company announcements published between two dates, newest first, with category, price_sensitive flag, title and full body; use to find the news behind a move, a dividend or a result.",
  params: announcementsParams,
  local(p, d) {
    const wanted = p.symbol ? [normalizeSymbol(p.symbol)] : [];
    return sortAnnouncementsByLatest(filterAnnouncements(d.announcements, { symbols: wanted, from: p.from, to: p.to })).map(
      (a): Row => ({ ...a, published_on: publishedYmd(a) }),
    );
  },
};

const fundamentalsLatest: NamedQuery<z.output<typeof fundamentalsParams>> = {
  id: "fundamentals_latest",
  description:
    "One company's quarters reported by a date, oldest first; the latest row adds the quarter-on-quarter EPS and profit change and the trailing P/E; use to check a thesis about earnings or valuation.",
  params: fundamentalsParams,
  local(p, d) {
    const asOf = resolveDate(d, p.as_of);
    const symbol = normalizeSymbol(p.symbol);
    if (!d.portfolio.instruments.has(symbol)) throw new QueryError("unknown_symbol", `Unknown symbol ${symbol}.`);
    const lastClose = latestQuote(barsBySymbol(dataUpTo(d.portfolio, asOf).bars).get(symbol) ?? [])?.ltp ?? null;
    const s = summariseFundamentals(d.fundamentals, symbol, asOf, lastClose);
    return s.quarters.map((q): Row => {
      const latest = q === s.latest;
      return {
        symbol: s.symbol,
        period_end: q.period_end,
        reported_on: q.reported_on,
        eps_bdt: q.eps_bdt,
        nav_per_share_bdt: q.nav_per_share_bdt,
        revenue_mn_bdt: q.revenue_mn_bdt,
        net_profit_mn_bdt: q.net_profit_mn_bdt,
        is_latest: latest,
        eps_change_pct: latest ? r2(s.epsChangePct) : null,
        net_profit_change_pct: latest ? r2(s.netProfitChangePct) : null,
        revenue_change_pct: latest ? r2(s.revenueChangePct) : null,
        trailing_pe: latest ? r2(s.trailingPe) : null,
        pe_basis: latest ? s.peBasis : null,
        last_close: latest ? lastClose : null,
      };
    });
  },
};

const dividendsBetween: NamedQuery<z.output<typeof dividendsParams>> = {
  id: "dividends_between",
  description:
    "Cash dividends and bonus issues the portfolio is entitled to, by record date between two dates, with shares held on the record date, the amount and whether it is paid by the end date; use for any question about dividends, ex-dividend drops or bonus shares.",
  params: dividendsParams,
  local(p, d) {
    const { transactions } = d.portfolio;
    const actions = d.portfolio.actions;
    const merged = withBonusShares(transactions, actions, p.to);
    const inRange = (recordDate: string) => recordDate >= p.from && recordDate <= p.to;
    const cash = dividendsFor(actions, merged, p.to)
      .filter((v) => inRange(v.record_date))
      .map(
        (v): Row => ({
          action_id: v.actionId,
          kind: "cash_dividend",
          symbol: v.symbol,
          record_date: v.record_date,
          ex_date: addDseTradingDays(v.record_date, 1),
          paid_on: v.paid_on,
          shares: v.shares,
          cash_per_share_bdt: v.cash_per_share_bdt,
          amount_bdt: v.amountBdt,
          bonus_shares: 0,
          paid: v.paid,
        }),
      );
    const byId = new Map(actions.map((a) => [`bonus-${a.id}`, a]));
    const bonus = bonusTransactions(actions, transactions, p.to).flatMap((t): Row[] => {
      const a = byId.get(t.id);
      if (!a || !inRange(a.record_date)) return [];
      return [
        {
          action_id: a.id,
          kind: "stock_dividend",
          symbol: a.symbol,
          record_date: a.record_date,
          ex_date: addDseTradingDays(a.record_date, 1),
          paid_on: a.paid_on,
          shares: sharesHeldOn(merged, a.symbol, a.record_date),
          cash_per_share_bdt: null,
          amount_bdt: 0,
          bonus_shares: Number(t.quantity),
          paid: a.paid_on <= p.to,
        },
      ];
    });
    return [...cash, ...bonus].sort((a, b) => String(a.record_date).localeCompare(String(b.record_date)) || String(a.action_id).localeCompare(String(b.action_id)));
  },
};

const journalForSymbolQuery: NamedQuery<z.output<typeof journalParams>> = {
  id: "journal_for_symbol",
  description:
    "The owner's own thesis, horizon and exit condition for each trade, newest first, up to a date, for one symbol or for every trade; use to check a thesis against what happened since.",
  params: journalParams,
  local(p, d) {
    const asOf = resolveDate(d, p.as_of);
    const { transactions } = dataUpTo(d.portfolio, asOf);
    const entries = p.symbol ? journalForSymbol(d.journal, transactions, p.symbol) : d.journal;
    const byId = new Map(transactions.map((t) => [t.id, t]));
    return entries
      .filter((e) => byId.has(e.transaction_id) && dhakaToday(new Date(e.created_at)) <= asOf)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((e): Row => {
        const t = byId.get(e.transaction_id)!;
        return {
          id: e.id,
          transaction_id: e.transaction_id,
          symbol: t.symbol,
          side: t.side,
          trade_date: dhakaToday(new Date(t.created_at)),
          quantity: Number(t.quantity),
          price_per_share: Number(t.price_per_share),
          thesis: e.thesis,
          horizon: e.horizon,
          exit_condition: e.exit_condition,
          tags: e.tags,
        };
      });
  },
};

const ruleFindings: NamedQuery<z.output<typeof ruleFindingsParams>> = {
  id: "rule_findings",
  description:
    "Each holding's weight, each sector's weight against its target, and every finding of the owner's rules (position limit, sector target, trade plan reached) on a date; use to check whether a rule is broken and by how much.",
  params: ruleFindingsParams,
  local(p, d) {
    const view = buildPortfolioView(d.portfolio, resolveDate(d, p.as_of));
    const positions = view.holdings.map(
      (h): Row => ({
        row_type: "position",
        symbol: h.symbol,
        sector: h.sector,
        shares: h.shares,
        market_value_bdt: h.marketValue,
        weight_pct: r2(h.weightPct),
      }),
    );
    const actual = sectorWeights(positionWeights(view.holdings));
    const actualByKey = new Map([...actual].map(([sector, pct]) => [sectorMatchKey(sector), { sector, pct }]));
    const targets = new Map(view.rules.sector_targets.map((t) => [sectorMatchKey(t.sector), t]));
    const keys = [...new Set([...actualByKey.keys(), ...targets.keys()])];
    const sectors = keys
      .map((k): Row => {
        const a = actualByKey.get(k);
        const t = targets.get(k);
        return {
          row_type: "sector",
          sector: a?.sector ?? t?.sector,
          weight_pct: r2(a?.pct ?? 0),
          target_pct: t?.target_percent ?? null,
          delta_pct: t ? r2((a?.pct ?? 0) - t.target_percent) : null,
        };
      })
      .sort((a, b) => Number(b.weight_pct) - Number(a.weight_pct));
    const findings = view.findings.map((f): Row => ({ row_type: "finding", ...findingRow(f) }));
    return [...positions, ...sectors, ...findings];
  },
};

const whatIf: NamedQuery<z.output<typeof whatIfParams>> = {
  id: "what_if",
  description:
    "One hypothetical trade previewed against the owner's rules: the cost, each holding's and sector's weight before and after, and any rule finding the trade would newly cause; use for a pre-trade check. It saves nothing.",
  params: whatIfParams,
  local(p, d) {
    const asOf = resolveDate(d, p.as_of);
    const r = previewTrade(d.portfolio, asOf, { symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price });
    if (!r.ok) throw new QueryError(r.error.startsWith("There is no price") ? "no_price" : "rejected", r.error);
    const trade: Row = {
      row_type: "trade",
      as_of: r.asOf,
      symbol: r.trade.symbol,
      side: r.trade.side,
      quantity: r.trade.quantity,
      price: r.trade.price,
      gross_bdt: r.trade.grossBdt,
      commission_bdt: r.trade.commissionBdt,
      cash_bdt: r.cashBdt,
      total_market_value_before_bdt: r.before.totalMarketValue,
      total_market_value_after_bdt: r.after.totalMarketValue,
    };
    const before = new Map(r.before.holdings.map((h) => [h.symbol, h]));
    const after = new Map(r.after.holdings.map((h) => [h.symbol, h]));
    const holdings = [...new Set([...before.keys(), ...after.keys()])].sort().map(
      (symbol): Row => ({
        row_type: "holding",
        symbol,
        shares_before: before.get(symbol)?.shares ?? 0,
        shares_after: after.get(symbol)?.shares ?? 0,
        weight_before_pct: r2(before.get(symbol)?.weightPct ?? 0),
        weight_after_pct: r2(after.get(symbol)?.weightPct ?? 0),
      }),
    );
    const sb = new Map(r.before.sectors.map((s) => [sectorMatchKey(s.sector), s]));
    const sa = new Map(r.after.sectors.map((s) => [sectorMatchKey(s.sector), s]));
    const targets = new Map(d.portfolio.rules.sector_targets.map((t) => [sectorMatchKey(t.sector), t.target_percent]));
    const sectors = [...new Set([...sb.keys(), ...sa.keys()])].map(
      (k): Row => ({
        row_type: "sector",
        sector: sa.get(k)?.sector ?? sb.get(k)?.sector,
        weight_before_pct: r2(sb.get(k)?.weightPct ?? 0),
        weight_after_pct: r2(sa.get(k)?.weightPct ?? 0),
        target_pct: targets.get(k) ?? null,
      }),
    );
    const newFindings = r.newFindings.map((f): Row => ({ row_type: "new_finding", ...findingRow(f) }));
    return [trade, ...holdings, ...sectors, ...newFindings];
  },
};

const reconciliationQuery: NamedQuery<z.output<typeof reconciliationParams>> = {
  id: "reconciliation",
  description:
    "Every difference between the ledger and the broker statement (mismatched, ledger-only and broker-only trades) and between the bank deposits and the contributions (bank-only and contribution-only), each with a stable issue_id; use for any reconciliation question.",
  params: reconciliationParams,
  local(_p, d) {
    const rec = reconcile({ broker: d.broker, ledger: d.portfolio.transactions, bank: d.bank, contributions: d.portfolio.contributions });
    const day = (iso: string) => dhakaToday(new Date(iso));
    const blank = { ref: null, ledger_id: null, date: null, symbol: null, side: null, quantity: null, price: null, field: null, broker_value: null, ledger_value: null, difference_bdt: null, amount_bdt: null };
    const rows: Row[] = [];
    for (const pair of rec.trades.mismatched) {
      const first = pair.differences[0];
      rows.push({
        ...blank,
        issue_id: pair.ledger.id,
        kind: "mismatched_trade",
        ref: pair.broker.broker_ref,
        ledger_id: pair.ledger.id,
        date: pair.broker.trade_date,
        symbol: pair.broker.symbol,
        side: pair.broker.side,
        quantity: pair.broker.quantity,
        price: pair.broker.price,
        field: first?.field ?? null,
        broker_value: first?.broker ?? null,
        ledger_value: first?.ledger ?? null,
        difference_bdt: first ? roundBdt(first.broker - first.ledger) : null,
        differences: pair.differences,
      });
    }
    for (const t of rec.trades.ledgerOnly) {
      rows.push({
        ...blank,
        issue_id: t.id,
        kind: "ledger_only_trade",
        ledger_id: t.id,
        date: day(t.created_at),
        symbol: t.symbol,
        side: t.side,
        quantity: Number(t.quantity),
        price: Number(t.price_per_share),
        amount_bdt: roundBdt(Number(t.quantity) * Number(t.price_per_share)),
      });
    }
    for (const b of rec.trades.brokerOnly) {
      rows.push({
        ...blank,
        issue_id: b.broker_ref,
        kind: "broker_only_trade",
        ref: b.broker_ref,
        date: b.trade_date,
        symbol: b.symbol,
        side: b.side,
        quantity: b.quantity,
        price: b.price,
        amount_bdt: roundBdt(b.quantity * b.price),
      });
    }
    for (const b of rec.deposits.bankOnly) {
      rows.push({ ...blank, issue_id: b.bank_ref, kind: "bank_only_deposit", ref: b.bank_ref, date: b.value_date, amount_bdt: b.amount_bdt });
    }
    for (const c of rec.deposits.contributionsOnly) {
      rows.push({ ...blank, issue_id: c.id, kind: "contribution_only_deposit", ledger_id: c.id, date: day(c.created_at), amount_bdt: c.amount_bdt });
    }
    return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.issue_id).localeCompare(String(b.issue_id)));
  },
};

// ---------------------------------------------------------------------------------------------- registry

export const QUERIES: { readonly [K in QueryId]: NamedQuery } = {
  week_moves: weekMoves as NamedQuery,
  sector_vs_stock: sectorVsStock as NamedQuery,
  announcements_between: announcementsBetween as NamedQuery,
  fundamentals_latest: fundamentalsLatest as NamedQuery,
  dividends_between: dividendsBetween as NamedQuery,
  journal_for_symbol: journalForSymbolQuery as NamedQuery,
  rule_findings: ruleFindings as NamedQuery,
  what_if: whatIf as NamedQuery,
  reconciliation: reconciliationQuery as NamedQuery,
};

export const QUERY_IDS = Object.keys(QUERIES) as QueryId[];

export function isQueryId(id: string): id is QueryId {
  return Object.prototype.hasOwnProperty.call(QUERIES, id);
}

export type CatalogueEntry = { id: QueryId; description: string; params: Record<string, unknown> };

/** What the Planner receives: the id, the description and the params as JSON schema, for every query. */
export function catalogue(): CatalogueEntry[] {
  return QUERY_IDS.map((id) => {
    const params = z.toJSONSchema(QUERIES[id].params, { io: "input" }) as Record<string, unknown>;
    delete params.$schema;
    return { id, description: QUERIES[id].description, params };
  });
}

export async function loadQueryData(): Promise<QueryData> {
  const [portfolio, sectorBars, announcements, fundamentals, journal, broker, bank] = await Promise.all([
    loadPortfolioData(),
    loadSectorIndexBars(),
    loadAnnouncements(),
    loadFundamentals(),
    loadJournal(),
    loadBrokerStatement(),
    loadBankDeposits(),
  ]);
  return { portfolio, sectorBars, announcements, fundamentals, journal, broker, bank };
}

/** Checks `raw` against the query's schema. Throws a QueryError that names each bad field. */
export function parseParams(id: string, raw: unknown): { id: QueryId; params: Record<string, unknown> } {
  if (!isQueryId(id)) throw new QueryError("unknown_query", `Unknown query ${id}. Known queries: ${QUERY_IDS.join(", ")}.`);
  const parsed = QUERIES[id].params.safeParse(raw ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
    throw new QueryError("invalid_params", `${id}: ${why}`);
  }
  return { id, params: parsed.data as Record<string, unknown> };
}

/**
 * Runs one query on the local data. `as_of` in the echoed params is the trading day the query ran for,
 * so a Friday request reads as the Thursday it became. Throws QueryError; an empty answer is `rows: []`.
 */
export function runLocal(id: string, raw: unknown, d: QueryData): QueryResult {
  const { id: queryId, params } = parseParams(id, raw);
  const resolved = typeof params.as_of === "string" ? { ...params, as_of: resolveDate(d, params.as_of) } : params;
  const rows = QUERIES[queryId].local(resolved, d);
  return { query_id: queryId, run_query_id: randomUUID(), params: resolved, rows, source: "local" };
}
