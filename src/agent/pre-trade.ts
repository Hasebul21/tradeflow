// The pre_trade task's fixed chain, built by code. Its evidence never changes, so there is no Planner call: code
// validates the trade (or the open plan), builds the five-step plan, and branches on the what_if rows. A new rule
// finding in what_if's rows is an escalation decided here, never by a model. Nothing here writes to data/. Pure
// functions over the input and the query rows, so tests need no model.
import type { PlannedStep, PlannerTrade } from "./agents/planner";
import type { QueryResult, Row } from "./queries";
import type { TradePlan } from "@/lib/data-types";
import { sectorMatchKey } from "@/lib/sector-targets";
import { normalizeSymbol } from "@/lib/symbol";

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The days of announcements the chain reads, up to as_of. */
export const ANNOUNCEMENT_DAYS = 30;

export const PRE_TRADE_FOCUS = "What the proposed trade would change in the weights and the rules, and whether it fits the owner's thesis for the symbol.";

/** What the Writer opens with and the reply carries when the trade would newly break a rule: decided in code. */
export type PreTradeEscalation = {
  /** The finding's kind, such as "sector_target" or "max_position_weight". */
  rule: string;
  /** Set for a sector rule. */
  sector?: string;
  /** Set for a position rule. */
  symbol?: string;
  /** The weight of the sector or holding before the trade, in percent; null when what_if shows none. */
  before: number | null;
  after: number | null;
  /** The finding's message from src/lib/rules.ts. */
  message: string;
};

export type ResolvedTrade = { ok: true; trade: PlannerTrade; plan_id: string | null } | { ok: false; message: string };

/**
 * The trade to preview, from `trade` or from an open plan_id (at its target price). Both, neither, an unknown
 * symbol, a side other than buy or sell, a quantity that is not a positive whole number, a price that is not
 * positive, an unknown plan and an executed plan are each a message for an InvalidInput reply.
 */
export function resolveTrade(
  input: { trade?: unknown; plan_id?: unknown },
  known: { hasSymbol: (symbol: string) => boolean; plans: readonly TradePlan[] },
): ResolvedTrade {
  const hasTrade = input.trade !== undefined && input.trade !== null;
  const hasPlan = input.plan_id !== undefined && input.plan_id !== null && input.plan_id !== "";
  if (hasTrade && hasPlan) return { ok: false, message: "Give either trade or plan_id, not both." };
  if (!hasTrade && !hasPlan) return { ok: false, message: "pre_trade needs a trade { symbol, side, quantity, price? } or a plan_id; usage: { \"task\": \"pre_trade\", \"trade\": { \"symbol\": \"EBL\", \"side\": \"buy\", \"quantity\": 100 } }." };

  if (hasPlan) {
    const id = String(input.plan_id);
    const found = known.plans.find((plan) => plan.id === id);
    if (found === undefined) return { ok: false, message: `Unknown plan_id ${JSON.stringify(id)}.` };
    if (found.executed) return { ok: false, message: `Plan ${id} is already executed; pre_trade reviews an open plan.` };
    if (found.quantity_shares === null || !Number.isInteger(found.quantity_shares) || found.quantity_shares <= 0) {
      return { ok: false, message: `Plan ${id} has no whole-share quantity to preview.` };
    }
    return { ok: true, trade: { symbol: found.symbol, side: found.side, quantity: found.quantity_shares, price: found.target_price }, plan_id: id };
  }

  if (!isObject(input.trade)) return { ok: false, message: "trade must be an object { symbol, side, quantity, price? }." };
  const { symbol: rawSymbol, side, quantity, price } = input.trade;
  const symbol = typeof rawSymbol === "string" ? normalizeSymbol(rawSymbol) : "";
  if (symbol === "") return { ok: false, message: "trade.symbol must be a DSE trading code." };
  if (!known.hasSymbol(symbol)) return { ok: false, message: `Unknown symbol ${symbol}: it is not in data/instruments.json.` };
  if (side !== "buy" && side !== "sell") return { ok: false, message: "trade.side must be buy or sell." };
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) return { ok: false, message: "trade.quantity must be a positive whole number." };
  if (price !== undefined && price !== null && (typeof price !== "number" || !Number.isFinite(price) || price <= 0)) {
    return { ok: false, message: "trade.price must be a positive number, or left out for the close on as_of." };
  }
  return { ok: true, trade: { symbol, side, quantity, ...(typeof price === "number" ? { price } : {}) }, plan_id: null };
}

/** yyyy-mm-dd minus whole days, in UTC. */
function minusDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** The fixed plan: what_if for the trade, then the symbol's journal, the rules, the last 30 days of announcements and the fundamentals. */
export function fixedPlan(trade: PlannerTrade, asOf: string): PlannedStep[] {
  const { symbol } = trade;
  return [
    {
      query_id: "what_if",
      params: { as_of: asOf, symbol, side: trade.side, quantity: trade.quantity, ...(trade.price === undefined ? {} : { price: trade.price }) },
      why: "What the trade would do to each weight and which rule findings it would newly cause.",
    },
    { query_id: "journal_for_symbol", params: { as_of: asOf, symbol }, why: `The owner's own thesis for ${symbol}, to say whether the trade fits it.` },
    { query_id: "rule_findings", params: { as_of: asOf }, why: "The owner's rules as they stand today, before the trade." },
    {
      query_id: "announcements_between",
      params: { from: minusDays(asOf, ANNOUNCEMENT_DAYS), to: asOf, symbol },
      why: `What ${symbol} announced in the last ${ANNOUNCEMENT_DAYS} days.`,
    },
    { query_id: "fundamentals_latest", params: { as_of: asOf, symbol }, why: `${symbol}'s latest reported quarters and trailing P/E.` },
  ];
}

export type PreTradeBranch = {
  /** The distinct kinds of what_if's new findings, in row order; empty when there are none. */
  new_findings: string[];
  /** Set when the trade would newly break a rule: the first new finding. */
  escalation: PreTradeEscalation | null;
};

/** Branches on the what_if result's rows: every row_type "new_finding" is a rule the trade would newly break. */
export function branchOnWhatIf(result: Pick<QueryResult, "rows">): PreTradeBranch {
  const rows: readonly Row[] = result.rows;
  const newRows = rows.filter((row) => row.row_type === "new_finding");
  const kinds = [...new Set(newRows.map((row) => str(row.kind)).filter((kind) => kind !== ""))];
  const first = newRows[0];
  if (first === undefined) return { new_findings: kinds, escalation: null };

  const rule = str(first.kind);
  const subject = str(first.subject);
  const message = str(first.message);
  if (rule === "sector_target") {
    const sector = rows.find((row) => row.row_type === "sector" && sectorMatchKey(str(row.sector)) === sectorMatchKey(subject));
    return { new_findings: kinds, escalation: { rule, sector: subject, before: num(sector?.weight_before_pct), after: num(sector?.weight_after_pct), message } };
  }
  if (rule === "max_position_weight") {
    const holding = rows.find((row) => row.row_type === "holding" && str(row.symbol) === subject);
    return { new_findings: kinds, escalation: { rule, symbol: subject, before: num(holding?.weight_before_pct), after: num(holding?.weight_after_pct), message } };
  }
  const symbol = str(first.symbol);
  return { new_findings: kinds, escalation: { rule, ...(symbol === "" ? {} : { symbol }), before: null, after: null, message } };
}
