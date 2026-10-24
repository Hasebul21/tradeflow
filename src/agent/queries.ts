// The named-query registry: the only way an agent reads the ledger. Each query calls the same src/lib
// function as its API route, so an answer matches what the page shows. Server only: loadQueryData reads data/.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config";
import { beforeQuery, type QueryWho } from "./guards";
import type { Tracer } from "./trace";
import { createZetarisClient, rowsFromArrays, type ZetarisClient } from "./zetaris";
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
import { PRICE_TOLERANCE_BDT, reconcile } from "@/lib/reconcile";
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
  /** The first 120 characters of the Lightning SQL that ran, or was tried before a fallback; null when no SQL was sent. */
  sql_head: string | null;
  /** The whole Lightning SQL statement Zetaris ran; left out unless source is "zetaris". */
  sql?: string;
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
  /**
   * One Lightning SQL statement for Zetaris: no trailing semicolon, qualified table names, aggregated in SQL.
   * It returns only `sqlColumns`; `local()` supplies the rest through mergeRows. Takes the resolved params.
   */
  sql?(p: P, d: QueryData): string;
  /** The SELECT list of sql(), in order. The reply is positional, so these names are the only column names. */
  sqlColumns?: readonly string[];
  sqlNumeric?: readonly string[];
  sqlBooleans?: readonly string[];
  /** Identifies a row in both the SQL rows and local() rows; null for a local row SQL never computes (the PORTFOLIO row). */
  sqlKey?(row: Row): string | null;
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

// ---------------------------------------------------------------------------------------------- sql helpers

const LEDGER = "tradeflow_ledger";
const EXTERNAL = "tradeflow_external";

/** A table as `SHOW DATASOURCE TABLES` lists it, qualified with its datasource (src/agent/zetaris-tables.txt). */
export function table(datasource: typeof LEDGER | typeof EXTERNAL, name: string): string {
  return `${datasource}.${name}`;
}

// The Dhaka day is a fixed +06:00 (no daylight saving), so a day is two absolute instants and the result
// does not depend on the Zetaris session time zone.
function ymdLiteral(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || parseYmd(s) === null) throw new QueryError("invalid_params", `${s} is not a date as yyyy-mm-dd.`);
  return s;
}
const dateLiteral = (s: string) => `CAST('${ymdLiteral(s)}' AS DATE)`;
const dayStart = (s: string) => `CAST('${ymdLiteral(s)}T00:00:00+06:00' AS TIMESTAMP)`;
/** The first instant after the Dhaka day `s`, as an exclusive upper bound. */
function dayEnd(s: string): string {
  const [y, m, d] = ymdLiteral(s).split("-").map(Number);
  return dayStart(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10));
}
/** The Dhaka calendar day of a timestamp column, whatever the session time zone is. */
const dhakaDay = (column: string) =>
  `date_format(from_utc_timestamp(to_utc_timestamp(${column}, current_timezone()), 'Asia/Dhaka'), 'yyyy-MM-dd')`;
/** The same day as a Spark DATE, for comparing with a DATE column (tested through zetaris.ts: t-021 is 2026-05-12). */
const dhakaDate = (column: string) => `to_date(from_utc_timestamp(to_utc_timestamp(${column}, current_timezone()), 'Asia/Dhaka'))`;
/** A ledger row's quantity, negative for a sell. */
const signedQuantity = (alias: string) =>
  `CASE WHEN ${alias}.side = 'buy' THEN CAST(${alias}.quantity AS DOUBLE) ELSE -CAST(${alias}.quantity AS DOUBLE) END`;
/** Money amounts closer than this are equal: MONEY_EPSILON in src/lib/reconcile.ts, which is not exported. */
const MONEY_EPSILON_SQL = 0.005;

/**
 * Bonus shares credited by `asOf` as (symbol, q) rows, as bonusTransactions credits them: floor(shares held on the
 * record date * bonus_ratio). One level only: a bonus that itself counts an earlier bonus of the same symbol is not
 * in the SQL, and parity would show it (the data has one bonus issue).
 */
function bonusSharesSql(asOf: string): string {
  return `SELECT UPPER(TRIM(a.symbol)) AS symbol, FLOOR(SUM(${signedQuantity("t")}) * CAST(a.bonus_ratio AS DOUBLE) + 1e-9) AS q
    FROM ${table(LEDGER, "corporate_actions")} a
    JOIN ${table(LEDGER, "transactions")} t ON UPPER(TRIM(t.symbol)) = UPPER(TRIM(a.symbol)) AND ${dhakaDate("t.created_at")} <= a.record_date
    WHERE a.kind = 'stock_dividend' AND a.record_date <= ${dateLiteral(asOf)} AND a.paid_on <= ${dateLiteral(asOf)}
    GROUP BY a.id, a.symbol, a.bonus_ratio`;
}

function sessionsLiteral(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 120) throw new QueryError("invalid_params", "sessions must be a whole number from 1 to 120.");
  return n;
}

/** A symbol that is in `instruments` and plain letters and digits; anything else never reaches SQL. */
function symbolLiteral(d: QueryData, raw: string): string {
  const symbol = normalizeSymbol(raw);
  if (!/^[A-Z0-9]{1,20}$/.test(symbol) || !d.portfolio.instruments.has(symbol)) throw new QueryError("unknown_symbol", `Unknown symbol ${symbol}.`);
  return `'${symbol}'`;
}

// ---------------------------------------------------------------------------------------------- queries

const weekMoves: NamedQuery<z.output<typeof weekMovesParams>> = {
  id: "week_moves",
  description:
    "Per holding, the move over the last sessions against its sector index and DSEX, with a PORTFOLIO row first (portfolio change against DSEX); use first for any question about what moved or why the week was good or bad.",
  params: weekMovesParams,
  sqlColumns: ["symbol", "from_close", "to_close", "change_pct"],
  sqlNumeric: ["from_close", "to_close", "change_pct"],
  sqlKey: (row) => (row.symbol === PORTFOLIO ? null : String(row.symbol)),
  // Held at the end of as_of: net bought shares above zero. Bonus shares are not in the SQL; a holding that
  // exists only through a bonus issue would be missing, and parity would show it.
  sql(p) {
    const asOf = p.as_of;
    const from = sessionsLiteral(p.sessions) + 1;
    return `SELECT symbol, from_close, to_close, ROUND((to_close - from_close) / from_close * 100, 2) AS change_pct
FROM (
  SELECT symbol,
         MAX(CASE WHEN rn = 1 THEN close END) AS to_close,
         MAX(CASE WHEN rn = ${from} THEN close END) AS from_close
  FROM (
    SELECT symbol, close, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY bar_date DESC) AS rn
    FROM ${table(LEDGER, "bars")}
    WHERE bar_date <= ${dateLiteral(asOf)}
      AND symbol IN (
        SELECT symbol FROM ${table(LEDGER, "transactions")}
        WHERE created_at < ${dayEnd(asOf)}
        GROUP BY symbol
        HAVING SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END) > 0
      )
  ) ranked
  WHERE rn IN (1, ${from})
  GROUP BY symbol
) w
WHERE from_close IS NOT NULL AND to_close IS NOT NULL
ORDER BY symbol`;
  },
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
  sqlColumns: ["sector", "close", "change_pct"],
  sqlNumeric: ["close", "change_pct"],
  sqlKey: (row) => String(row.sector),
  sql(p) {
    const from = sessionsLiteral(p.sessions) + 1;
    return `SELECT sector, close, ROUND((close - from_close) / from_close * 100, 2) AS change_pct
FROM (
  SELECT sector,
         MAX(CASE WHEN rn = 1 THEN close END) AS close,
         MAX(CASE WHEN rn = ${from} THEN close END) AS from_close
  FROM (
    SELECT sector, close, ROW_NUMBER() OVER (PARTITION BY sector ORDER BY bar_date DESC) AS rn
    FROM ${table(LEDGER, "sector_index_bars")}
    WHERE bar_date <= ${dateLiteral(p.as_of)}
  ) ranked
  WHERE rn IN (1, ${from})
  GROUP BY sector
) w
WHERE from_close IS NOT NULL AND close IS NOT NULL
ORDER BY change_pct, sector`;
  },
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
  sqlColumns: ["id", "symbol", "published_on", "category", "price_sensitive", "title"],
  sqlBooleans: ["price_sensitive"],
  sqlKey: (row) => String(row.id),
  // The body stays out of the statement: it is long, and mergeRows takes it from local().
  sql(p, d) {
    const symbol = p.symbol ? `\n  AND symbol = ${symbolLiteral(d, p.symbol)}` : "";
    return `SELECT id, symbol, ${dhakaDay("published_at")} AS published_on, category, price_sensitive, title
FROM ${table(EXTERNAL, "announcements")}
WHERE published_at >= ${dayStart(p.from)}
  AND published_at < ${dayEnd(p.to)}${symbol}
ORDER BY published_at DESC, id DESC`;
  },
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
  sqlColumns: ["symbol", "period_end", "reported_on", "eps_bdt", "nav_per_share_bdt", "revenue_mn_bdt", "net_profit_mn_bdt"],
  sqlNumeric: ["eps_bdt", "nav_per_share_bdt", "revenue_mn_bdt", "net_profit_mn_bdt"],
  sqlKey: (row) => `${row.symbol}|${row.period_end}`,
  // The quarter-on-quarter changes and the trailing P/E come from local(), through src/lib.
  sql(p, d) {
    return `SELECT symbol, period_end, reported_on, eps_bdt, nav_per_share_bdt, revenue_mn_bdt, net_profit_mn_bdt
FROM ${table(EXTERNAL, "fundamentals")}
WHERE symbol = ${symbolLiteral(d, p.symbol)}
  AND reported_on <= ${dateLiteral(p.as_of)}
ORDER BY period_end`;
  },
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
  sqlColumns: ["action_id", "kind", "symbol", "record_date", "paid_on", "shares", "cash_per_share_bdt", "amount_bdt", "bonus_shares", "paid"],
  sqlNumeric: ["shares", "cash_per_share_bdt", "amount_bdt", "bonus_shares"],
  sqlBooleans: ["paid"],
  sqlKey: (row) => String(row.action_id),
  // Shares on the record date are the ledger's net shares by that Dhaka day plus the bonus shares credited by then
  // (one level, as bonusSharesSql). ex_date is a DSE trading-calendar step, so it comes from local().
  sql(p) {
    const to = dateLiteral(p.to);
    return `WITH acts AS (
  SELECT id, kind, UPPER(TRIM(symbol)) AS symbol, record_date, paid_on,
         CAST(cash_per_share_bdt AS DOUBLE) AS cash, CAST(bonus_ratio AS DOUBLE) AS ratio
  FROM ${table(LEDGER, "corporate_actions")}
),
held AS (
  SELECT a.id, COALESCE(SUM(${signedQuantity("t")}), 0) AS ledger_shares
  FROM acts a
  LEFT JOIN ${table(LEDGER, "transactions")} t ON UPPER(TRIM(t.symbol)) = a.symbol AND ${dhakaDate("t.created_at")} <= a.record_date
  GROUP BY a.id
),
bonus AS (
  SELECT a.symbol, a.paid_on, FLOOR(h.ledger_shares * a.ratio + 1e-9) AS bonus_shares
  FROM acts a JOIN held h ON h.id = a.id
  WHERE a.kind = 'stock_dividend' AND a.paid_on <= ${to}
),
ent AS (
  SELECT a.id, a.kind, a.symbol, a.record_date, a.paid_on, a.cash, a.ratio,
         MAX(h.ledger_shares) + COALESCE(SUM(b.bonus_shares), 0) AS shares
  FROM acts a
  JOIN held h ON h.id = a.id
  LEFT JOIN bonus b ON b.symbol = a.symbol AND b.paid_on <= a.record_date
  WHERE a.record_date >= ${dateLiteral(p.from)} AND a.record_date <= ${to}
  GROUP BY a.id, a.kind, a.symbol, a.record_date, a.paid_on, a.cash, a.ratio
)
SELECT id AS action_id, kind, symbol, date_format(record_date, 'yyyy-MM-dd') AS record_date, date_format(paid_on, 'yyyy-MM-dd') AS paid_on, shares,
       CASE WHEN kind = 'cash_dividend' THEN COALESCE(cash, 0) END AS cash_per_share_bdt,
       CASE WHEN kind = 'cash_dividend' THEN ROUND(shares * COALESCE(cash, 0), 2) ELSE 0 END AS amount_bdt,
       CASE WHEN kind = 'stock_dividend' THEN FLOOR(shares * ratio + 1e-9) ELSE 0 END AS bonus_shares,
       paid_on <= ${to} AS paid
FROM ent
WHERE (kind = 'cash_dividend' AND shares > 0)
   OR (kind = 'stock_dividend' AND paid_on <= ${to} AND FLOOR(shares * ratio + 1e-9) > 0)
ORDER BY record_date, action_id`;
  },
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
  sqlColumns: ["id", "transaction_id", "symbol", "side", "trade_date", "quantity", "price_per_share", "horizon", "thesis", "exit_condition"],
  sqlNumeric: ["quantity", "price_per_share"],
  sqlKey: (row) => String(row.id),
  // The tags (text[]) stay with local(): array support in Lightning SQL is not confirmed.
  sql(p, d) {
    const symbol = p.symbol ? `\n  AND t.symbol = ${symbolLiteral(d, p.symbol)}` : "";
    return `SELECT j.id, j.transaction_id, t.symbol, t.side, ${dhakaDay("t.created_at")} AS trade_date, t.quantity, t.price_per_share,
       j.horizon, j.thesis, j.exit_condition
FROM ${table(LEDGER, "journal")} j
JOIN ${table(LEDGER, "transactions")} t ON t.id = j.transaction_id
WHERE j.created_at < ${dayEnd(p.as_of)}
  AND t.created_at < ${dayEnd(p.as_of)}${symbol}
ORDER BY j.created_at DESC, j.id DESC`;
  },
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
  sqlColumns: ["row_type", "symbol", "sector", "shares", "market_value_bdt", "weight_pct", "target_pct", "delta_pct"],
  sqlNumeric: ["shares", "market_value_bdt", "weight_pct", "target_pct", "delta_pct"],
  // The position and sector rows come from SQL; the finding rows (kind, limits, the rule's message) stay with
  // local(), through src/lib/rules.ts, and keep their place, as the PORTFOLIO row does for week_moves.
  sqlKey: (row) =>
    row.row_type === "position" ? `position|${String(row.symbol)}` : row.row_type === "sector" ? `sector|${sectorMatchKey(String(row.sector))}` : null,
  sql(p) {
    const asOf = p.as_of;
    return `WITH ledger AS (
  SELECT UPPER(TRIM(t.symbol)) AS symbol, ${signedQuantity("t")} AS q
  FROM ${table(LEDGER, "transactions")} t
  WHERE t.created_at < ${dayEnd(asOf)}
  UNION ALL
  ${bonusSharesSql(asOf)}
),
held AS (
  SELECT symbol, SUM(q) AS shares FROM ledger GROUP BY symbol HAVING SUM(q) > 0
),
last_close AS (
  SELECT symbol, close FROM (
    SELECT UPPER(TRIM(symbol)) AS symbol, CAST(close AS DOUBLE) AS close,
           ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(symbol)) ORDER BY bar_date DESC) AS rn
    FROM ${table(LEDGER, "bars")}
    WHERE bar_date <= ${dateLiteral(asOf)}
  ) ranked
  WHERE rn = 1
),
pos AS (
  SELECT h.symbol, i.sector, COALESCE(NULLIF(TRIM(i.sector), ''), 'Unknown') AS sector_key, h.shares, ROUND(c.close * h.shares, 2) AS mv
  FROM held h
  JOIN last_close c ON c.symbol = h.symbol
  LEFT JOIN ${table(LEDGER, "instruments")} i ON UPPER(TRIM(i.symbol)) = h.symbol
),
total AS (
  SELECT SUM(mv) AS tmv FROM pos WHERE mv > 0
),
sec AS (
  SELECT p.sector_key AS sector, SUM(p.mv) / MAX(t.tmv) * 100 AS pct
  FROM pos p CROSS JOIN total t
  WHERE p.mv > 0
  GROUP BY p.sector_key
),
tgt AS (
  SELECT TRIM(sector) AS sector, CAST(target_percent AS DOUBLE) AS target_pct FROM ${table(LEDGER, "sector_targets")}
)
SELECT 'position' AS row_type, p.symbol, p.sector, p.shares, p.mv AS market_value_bdt, ROUND(p.mv / t.tmv * 100, 2) AS weight_pct,
       CAST(NULL AS DOUBLE) AS target_pct, CAST(NULL AS DOUBLE) AS delta_pct
FROM pos p CROSS JOIN total t
UNION ALL
SELECT 'sector' AS row_type, CAST(NULL AS STRING) AS symbol, COALESCE(s.sector, g.sector) AS sector, CAST(NULL AS DOUBLE) AS shares,
       CAST(NULL AS DOUBLE) AS market_value_bdt, ROUND(COALESCE(s.pct, 0), 2) AS weight_pct, g.target_pct,
       CASE WHEN g.sector IS NULL THEN CAST(NULL AS DOUBLE) ELSE ROUND(COALESCE(s.pct, 0) - g.target_pct, 2) END AS delta_pct
FROM sec s FULL OUTER JOIN tgt g ON LOWER(s.sector) = LOWER(g.sector)
ORDER BY row_type, weight_pct DESC`;
  },
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
  sqlColumns: ["issue_id", "kind", "ref", "ledger_id", "date", "symbol", "side", "quantity", "price", "field", "broker_value", "ledger_value", "difference_bdt", "amount_bdt", "commission_bdt"],
  sqlNumeric: ["quantity", "price", "broker_value", "ledger_value", "difference_bdt", "amount_bdt", "commission_bdt"],
  sqlKey: (row) => String(row.issue_id),
  // One statement across both datasources: the ledger's transactions and contributions against the broker
  // statement and the bank deposits. A trade matches on its Dhaka day, symbol, side and quantity, at a price within
  // PRICE_TOLERANCE_BDT; a deposit on its Dhaka day and amount. ROW_NUMBER pairs repeated keys one to one, as
  // reconcileTrades uses each row once. A full outer join keeps the rows only one side has; a matched pair stays
  // only when its commission or price differs. The difference kinds are joined with UNION ALL.
  sql() {
    const ledgerDay = dhakaDate("created_at");
    return `WITH b AS (
  SELECT broker_ref, date_format(trade_date, 'yyyy-MM-dd') AS d, UPPER(TRIM(symbol)) AS sym, symbol, side,
         CAST(quantity AS DOUBLE) AS quantity, CAST(price AS DOUBLE) AS price, CAST(commission_bdt AS DOUBLE) AS commission_bdt,
         ROW_NUMBER() OVER (PARTITION BY trade_date, UPPER(TRIM(symbol)), side, CAST(quantity AS DOUBLE) ORDER BY broker_ref) AS rn
  FROM ${table(EXTERNAL, "broker_statement")}
),
l AS (
  SELECT id, date_format(${ledgerDay}, 'yyyy-MM-dd') AS d, UPPER(TRIM(symbol)) AS sym, symbol, side,
         CAST(quantity AS DOUBLE) AS quantity, CAST(price_per_share AS DOUBLE) AS price, ROUND(COALESCE(CAST(fees_bdt AS DOUBLE), 0), 2) AS fee,
         ROW_NUMBER() OVER (PARTITION BY ${ledgerDay}, UPPER(TRIM(symbol)), side, CAST(quantity AS DOUBLE) ORDER BY created_at, id) AS rn
  FROM ${table(LEDGER, "transactions")}
),
k AS (
  SELECT bank_ref, date_format(value_date, 'yyyy-MM-dd') AS d, CAST(amount_bdt AS DOUBLE) AS amount,
         ROW_NUMBER() OVER (PARTITION BY value_date, ROUND(CAST(amount_bdt AS DOUBLE), 2) ORDER BY bank_ref) AS rn
  FROM ${table(EXTERNAL, "bank_deposits")}
),
c AS (
  SELECT id, date_format(${ledgerDay}, 'yyyy-MM-dd') AS d, CAST(amount_bdt AS DOUBLE) AS amount,
         ROW_NUMBER() OVER (PARTITION BY ${ledgerDay}, ROUND(CAST(amount_bdt AS DOUBLE), 2) ORDER BY created_at, id) AS rn
  FROM ${table(LEDGER, "contributions")}
),
trades AS (
  SELECT b.broker_ref, b.d AS b_d, b.symbol AS b_symbol, b.side AS b_side, b.quantity AS b_quantity, b.price AS b_price, b.commission_bdt,
         l.id AS ledger_id, l.d AS l_d, l.symbol AS l_symbol, l.side AS l_side, l.quantity AS l_quantity, l.price AS l_price, l.fee,
         ABS(b.commission_bdt - l.fee) > ${MONEY_EPSILON_SQL} AS fee_differs, ABS(b.price - l.price) > ${MONEY_EPSILON_SQL} AS price_differs
  FROM b FULL OUTER JOIN l
    ON b.d = l.d AND b.sym = l.sym AND b.side = l.side AND b.quantity = l.quantity AND b.rn = l.rn
   AND ABS(b.price - l.price) <= ${PRICE_TOLERANCE_BDT} + 1e-9
)
SELECT issue_id, kind, ref, ledger_id, \`date\`, symbol, side, quantity, price, field, broker_value, ledger_value, difference_bdt, amount_bdt, commission_bdt
FROM (
  SELECT COALESCE(ledger_id, broker_ref) AS issue_id,
         CASE WHEN ledger_id IS NULL THEN 'broker_only_trade' WHEN broker_ref IS NULL THEN 'ledger_only_trade' ELSE 'mismatched_trade' END AS kind,
         broker_ref AS ref, ledger_id, COALESCE(b_d, l_d) AS \`date\`, COALESCE(b_symbol, l_symbol) AS symbol, COALESCE(b_side, l_side) AS side,
         COALESCE(b_quantity, l_quantity) AS quantity, COALESCE(b_price, l_price) AS price,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS STRING) WHEN fee_differs THEN 'commission_bdt' ELSE 'price' END AS field,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS DOUBLE) WHEN fee_differs THEN commission_bdt ELSE b_price END AS broker_value,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS DOUBLE) WHEN fee_differs THEN fee ELSE l_price END AS ledger_value,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS DOUBLE) WHEN fee_differs THEN ROUND(commission_bdt - fee, 2) ELSE ROUND(b_price - l_price, 2) END AS difference_bdt,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN ROUND(COALESCE(b_quantity, l_quantity) * COALESCE(b_price, l_price), 2) ELSE CAST(NULL AS DOUBLE) END AS amount_bdt,
         CASE WHEN ledger_id IS NULL THEN commission_bdt ELSE CAST(NULL AS DOUBLE) END AS commission_bdt
  FROM trades
  WHERE broker_ref IS NULL OR ledger_id IS NULL OR fee_differs OR price_differs
  UNION ALL
  SELECT COALESCE(c.id, k.bank_ref) AS issue_id,
         CASE WHEN c.id IS NULL THEN 'bank_only_deposit' ELSE 'contribution_only_deposit' END AS kind,
         k.bank_ref AS ref, c.id AS ledger_id, COALESCE(k.d, c.d) AS \`date\`, CAST(NULL AS STRING) AS symbol, CAST(NULL AS STRING) AS side,
         CAST(NULL AS DOUBLE) AS quantity, CAST(NULL AS DOUBLE) AS price, CAST(NULL AS STRING) AS field, CAST(NULL AS DOUBLE) AS broker_value,
         CAST(NULL AS DOUBLE) AS ledger_value, CAST(NULL AS DOUBLE) AS difference_bdt, COALESCE(k.amount, c.amount) AS amount_bdt,
         CAST(NULL AS DOUBLE) AS commission_bdt
  FROM k FULL OUTER JOIN c ON k.d = c.d AND ABS(k.amount - c.amount) <= ${MONEY_EPSILON_SQL} AND k.rn = c.rn
  WHERE k.bank_ref IS NULL OR c.id IS NULL
) issues
ORDER BY \`date\`, issue_id`;
  },
  local(_p, d) {
    const rec = reconcile({ broker: d.broker, ledger: d.portfolio.transactions, bank: d.bank, contributions: d.portfolio.contributions });
    const day = (iso: string) => dhakaToday(new Date(iso));
    const blank = { ref: null, ledger_id: null, date: null, symbol: null, side: null, quantity: null, price: null, field: null, broker_value: null, ledger_value: null, difference_bdt: null, amount_bdt: null, commission_bdt: null };
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
        // An approved fix writes it as the new transaction's fees_bdt, so the trade then matches with no fee difference.
        commission_bdt: b.commission_bdt,
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

/** Checks the params and moves `as_of` to the trading day the query runs for. Throws a QueryError. */
export function prepareQuery(id: string, raw: unknown, d: QueryData): { id: QueryId; params: Record<string, unknown> } {
  const { id: queryId, params } = parseParams(id, raw);
  return { id: queryId, params: typeof params.as_of === "string" ? { ...params, as_of: resolveDate(d, params.as_of) } : params };
}

/**
 * Runs one query on the local data. `as_of` in the echoed params is the trading day the query ran for,
 * so a Friday request reads as the Thursday it became. Throws QueryError; an empty answer is `rows: []`.
 */
export function runLocal(id: string, raw: unknown, d: QueryData): QueryResult {
  const { id: queryId, params } = prepareQuery(id, raw, d);
  const rows = QUERIES[queryId].local(params, d);
  return { query_id: queryId, run_query_id: randomUUID(), params, rows, source: "local", sql_head: null };
}

// ---------------------------------------------------------------------------------------------- zetaris

/** guards.beforeQuery blocked the call; `reason` is the guard's. runQuery throws it before any Query trace line. */
export class QueryBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "QueryBlockedError";
  }
}

const SQL_HEAD_CHARS = 120;
const PARAMS_SUMMARY_CHARS = 200;
const capped = (text: string) => (text.length <= PARAMS_SUMMARY_CHARS ? text : `${text.slice(0, PARAMS_SUMMARY_CHARS)}...`);
const sqlHeadOf = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, SQL_HEAD_CHARS);

/**
 * The SQL rows laid over local(): each row keeps local()'s extra columns (labels, weights, the body) and takes
 * the SQL's values for the SQL's columns. Zetaris decides which rows exist; local() decides their order. A local
 * row with a null key (the PORTFOLIO row) stays where it is. No SQL rows means no rows at all.
 */
export function mergeRows(q: NamedQuery, local: Row[], sqlRows: Row[]): Row[] {
  const key = q.sqlKey;
  if (!key || sqlRows.length === 0) return sqlRows;
  const bySql = new Map(sqlRows.map((row) => [key(row), row]));
  const used = new Set<string | null>();
  const merged: Row[] = [];
  for (const row of local) {
    const k = key(row);
    if (k === null) {
      merged.push(row);
      continue;
    }
    const fromSql = bySql.get(k);
    if (fromSql) {
      merged.push({ ...row, ...fromSql });
      used.add(k);
    }
  }
  for (const [k, row] of bySql) if (!used.has(k)) merged.push(row);
  return merged;
}

export type FetchDeps = {
  data: QueryData;
  zetaris: ZetarisClient | null;
  tracer: Tracer;
  timeoutMs: number;
  /** Why there is no client, for the trace: "sample mode" or "Zetaris not configured". */
  offReason?: string;
  /** The run's cancel signal; it ends the Zetaris request, and a cancelled call never falls back to local(). */
  signal?: AbortSignal;
};

export type FetchedRows = { rows: Row[]; source: QuerySource; sqlHead: string | null; why: string | null; sql?: string };

/**
 * Rows for one validated query. Zetaris when there is a client and the query has sql(); otherwise local().
 * A Zetaris failure (a timeout after its one retry, a 401, bad SQL, Postgres down behind it) gives local() with
 * source "local-fallback". A QueryError from the params or local() is the caller's to handle, never a fallback.
 */
export async function fetchRows(id: QueryId, params: Record<string, unknown>, deps: FetchDeps): Promise<FetchedRows> {
  const q = QUERIES[id];
  const local = q.local(params, deps.data);
  if (deps.zetaris === null || !q.sql || !q.sqlColumns) {
    const why = id === "what_if" ? WHAT_IF_LOCAL : !q.sql ? "this query has no sql() yet" : (deps.offReason ?? "Zetaris is off for this call");
    return { rows: local, source: "local", sqlHead: null, why };
  }
  let sql: string;
  try {
    sql = q.sql(params, deps.data);
  } catch (error) {
    // A symbol that is not in instruments never reaches SQL. local() then answers exactly as it does in sample
    // mode (an empty list, or its own QueryError), so the two modes agree.
    if (error instanceof QueryError) return { rows: local, source: "local", sqlHead: null, why: `no SQL sent: ${error.message}` };
    throw error;
  }
  const sqlHead = sqlHeadOf(sql);
  try {
    const reply = await deps.zetaris.run(sql, {
      timeoutMs: deps.timeoutMs,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      onRetry: () =>
        deps.tracer.log({
          agent_name: "Query",
          action: "retry",
          input_summary: `${id} sql: ${sqlHead}`,
          output_summary: "Zetaris timed out; retrying once",
          status: "retry",
          source: "zetaris",
          why: "timeout",
        }),
    });
    const sqlRows = rowsFromArrays(q.sqlColumns, reply.data, new Set(q.sqlNumeric), new Set(q.sqlBooleans));
    return { rows: mergeRows(q, local, sqlRows), source: "zetaris", sqlHead, why: null, sql: reply.sql };
  } catch (error) {
    // A cancelled run stops here; carrying on with local rows would only spend its time.
    if (deps.signal?.aborted) throw error;
    const why = error instanceof Error ? `${(error as { type?: string }).type ?? error.name}: ${error.message}` : "unknown error";
    return { rows: local, source: "local-fallback", sqlHead, why };
  }
}

const WHAT_IF_LOCAL = "what_if has no sql(): it previews a trade that has not happened, so it always runs locally";

export type RunQueryArgs = {
  query_id: string;
  params: unknown;
  /** The run this call belongs to; the per-run cache and budget, added later, are keyed by it. */
  runId: string;
  tracer: Tracer;
  config: Config;
  /** True keeps every call local. Decided by the caller from SAMPLE_MODE and the request's options. */
  sampleMode: boolean;
  /** The loaded data; loaded here when the caller has none. */
  data?: QueryData;
  /** A client to use instead of the one built from config.zetaris. Null forces local. */
  zetaris?: ZetarisClient | null;
  /** Set when every call must run locally (the eval's fixture data dir is not in Postgres): the reason the trace gives. */
  localReason?: string;
  /** The run's query-call limit for guards.beforeQuery; defaults to config.MAX_QUERY_CALLS. A later step passes the run's value. */
  maxQueries?: number;
  /** Calls the run has already made; defaults to 0. A later step passes the run's count. */
  queriesUsed?: number;
  /** The run's cancel signal: checked before the call and passed to the Zetaris request. A cancelled call throws the signal's reason and writes no Query line. */
  signal?: AbortSignal;
  /** Who runs the call and for which task; guards.beforeQuery checks src/agent/policy.ts when it is set. */
  who?: QueryWho;
};

/**
 * The one way an agent runs a named query. Chooses the source (Zetaris when it is configured, the query has
 * sql() and sample mode is off; otherwise local), writes one "Query" trace line and returns the rows.
 * guards.beforeQuery runs first: a block throws QueryBlockedError with the guard's reason and writes no Query line.
 * Throws QueryError when local() refuses the call; never throws for a Zetaris failure.
 */
export async function runQuery(args: RunQueryArgs): Promise<QueryResult> {
  const started = Date.now();
  const { tracer, config } = args;
  args.signal?.throwIfAborted();
  const data = args.data ?? (await loadQueryData());
  const guard = await beforeQuery(
    { query_id: args.query_id, params: args.params },
    { used: args.queriesUsed ?? 0, max: args.maxQueries ?? config.MAX_QUERY_CALLS },
    tracer,
    data,
    args.who,
  );
  if (!guard.ok) throw new QueryBlockedError(guard.reason);
  let prepared: ReturnType<typeof prepareQuery>;
  try {
    prepared = prepareQuery(args.query_id, guard.params, data);
  } catch (error) {
    tracer.log({
      agent_name: "Query",
      action: "query",
      input_summary: `${args.query_id} ${capped(JSON.stringify(args.params ?? {}))}`,
      output_summary: error instanceof Error ? error.message : "The query was refused.",
      status: "error",
      duration_ms: Date.now() - started,
    });
    throw error;
  }
  const { id, params } = prepared;
  const localOnly = args.localReason !== undefined && args.localReason !== "";
  const zetaris = args.sampleMode || localOnly ? null : args.zetaris === undefined ? createZetarisClient(config.zetaris) : args.zetaris;
  const offReason = localOnly ? (args.localReason as string) : args.sampleMode ? "sample mode: every call runs locally" : "Zetaris not configured";
  let fetched: FetchedRows;
  try {
    fetched = await fetchRows(id, params, { data, zetaris, tracer, timeoutMs: config.QUERY_TIMEOUT_MS, offReason, ...(args.signal === undefined ? {} : { signal: args.signal }) });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    // local() refused the call (an unknown symbol, a date outside the data): trace it, then let the caller decide.
    tracer.log({
      agent_name: "Query",
      action: "query",
      input_summary: `${id} ${capped(JSON.stringify(params))}`,
      output_summary: error instanceof Error ? error.message : "The query was refused.",
      status: "error",
      duration_ms: Date.now() - started,
    });
    throw error;
  }
  const { why } = fetched;
  tracer.log({
    agent_name: "Query",
    action: "query",
    input_summary: `${id} ${capped(JSON.stringify(params))} source=${fetched.source}${fetched.sqlHead === null ? "" : ` sql: ${fetched.sqlHead}`}`,
    output_summary: `${fetched.rows.length} rows`,
    status: fetched.source === "local-fallback" ? "fallback" : "ok",
    source: fetched.source,
    ...(why === null ? {} : { why }),
    duration_ms: Date.now() - started,
    // One query call of the run's budget; a cached result (run-state.ts) writes no usage.
    usage: { query_calls: 1 },
  });
  return { query_id: id, run_query_id: randomUUID(), params, rows: fetched.rows, source: fetched.source, sql_head: fetched.sqlHead, ...(fetched.sql === undefined ? {} : { sql: fetched.sql }) };
}
