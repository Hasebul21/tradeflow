// The reconcile task's fixed chain and the owner's approval, decided by code from the reconciliation rows. Code
// builds the plan (reconciliation, then the journal of each symbol a trade difference names), the proposed fix of
// each issue, the proposals in the reply and the one ledger edit an approval makes. A model only explains; nothing
// here reads model text. Pure functions over rows and settings: the orchestrator does the writes, through src/lib.
import path from "node:path";
import type { PlannedStep } from "./agents/planner";
import type { Finding } from "./guards";
import type { Row } from "./queries";
import type { Contribution } from "@/lib/data-types";
import type { TransactionRow } from "@/lib/portfolio";
import { normalizeSymbol } from "@/lib/symbol";

export const RECONCILE_FOCUS =
  "Each difference between the ledger and the broker and bank files: what differs, the amounts, the reason when a row states one, and a proposed fix for the owner to approve.";

/** Every reconcile_approve reply that writes nothing because the data dir is the repo's own data/. */
export const APPROVE_REFUSED = "Start the app with TRADEFLOW_DATA_DIR set to a copy to apply fixes.";
/** Said after every applied fix: Zetaris reads Postgres, which npm run db:load fills from data/. */
export const ZETARIS_STALE = "Zetaris still shows the old rows until npm run db:load.";

export type Proposal = { issue_id: string; explanation: string; proposed_fix: string; cites: string[]; status: "awaiting_approval" };

/** What an approval does: add the missing row, or nothing when the owner has to check by hand. */
export type LedgerEdit =
  | { op: "add_transaction"; row: TransactionRow }
  | { op: "add_contribution"; row: Contribution }
  | { op: "manual_check"; reason: string };

const str = (value: unknown): string => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const TRADE_KINDS = new Set(["mismatched_trade", "ledger_only_trade", "broker_only_trade"]);

/**
 * The fixed plan once the reconciliation rows are in: reconciliation first, then journal_for_symbol for each symbol a
 * trade difference names, in symbol order, so the Analyst can say which journal entry a trade carries. At most
 * `maxSteps` steps; the symbols left out are returned so the trace can name them.
 */
export function reconcilePlan(rows: readonly Row[], asOf: string, maxSteps: number): { steps: PlannedStep[]; left_out: string[] } {
  const bySymbol = new Map<string, string[]>();
  for (const row of rows) {
    if (!TRADE_KINDS.has(str(row.kind)) || str(row.symbol) === "") continue;
    const symbol = normalizeSymbol(str(row.symbol));
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), str(row.issue_id)]);
  }
  const steps: PlannedStep[] = [{ query_id: "reconciliation", params: {}, why: "Every difference between the ledger and the broker and bank files, each with its issue_id." }];
  const symbols = [...bySymbol.keys()].sort();
  const room = Math.max(0, maxSteps - steps.length);
  for (const symbol of symbols.slice(0, room)) {
    steps.push({ query_id: "journal_for_symbol", params: { as_of: asOf, symbol }, why: `The owner's journal for ${symbol}, which trade difference ${bySymbol.get(symbol)!.join(", ")} names.` });
  }
  return { steps, left_out: symbols.slice(room) };
}

/** The proposed fix in the form for the row's kind. Built from the row alone. */
export function proposedFix(row: Row): string {
  const issue = str(row.issue_id);
  switch (str(row.kind)) {
    case "broker_only_trade":
      return `add a transaction of ${str(row.side)} ${str(row.quantity)} ${str(row.symbol)} at Tk ${str(row.price)} on ${str(row.date)} (${str(row.ref)})`;
    case "bank_only_deposit":
      return `add a contribution of Tk ${str(row.amount_bdt)} on ${str(row.date)} (${str(row.ref)})`;
    case "mismatched_trade":
      return `manual check: ${str(row.field)} differs between ledger ${str(row.ledger_id) || issue} and broker ${str(row.ref)}`;
    case "ledger_only_trade":
      return `manual check: ledger trade ${str(row.ledger_id) || issue} has no broker row`;
    case "contribution_only_deposit":
      return `manual check: contribution ${str(row.ledger_id) || issue} has no bank deposit`;
    default:
      return `manual check: issue ${issue} is of an unknown kind`;
  }
}

/**
 * output.proposals: one per reconciliation row, in row order. The explanation is the claim of the issue's
 * reconciliation finding; the proposed fix is built by code from the row, so what the owner approves is never model
 * text. An issue with no finding still gets its proposal, explained as "not known".
 */
export function proposalsFrom(rows: readonly Row[], findings: readonly Finding[], reconciliationId: string): Proposal[] {
  return rows.map((row) => {
    const issue = str(row.issue_id);
    const found = findings.find((finding) => finding.kind === "reconciliation" && finding.subject === issue);
    return {
      issue_id: issue,
      explanation: found?.claim ?? `${issue}: not known; no finding explains it.`,
      proposed_fix: proposedFix(row),
      cites: found === undefined ? [reconciliationId] : [...found.cites],
      status: "awaiting_approval",
    };
  });
}

/**
 * reconcile_approve writes only in Docker (NODE_ENV production) or with TRADEFLOW_DATA_DIR set to a directory other
 * than the repo's own data/ (.env.example sets it to ./data, which never counts).
 */
export function canApply(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): boolean {
  if (env.NODE_ENV === "production") return true;
  const dir = env.TRADEFLOW_DATA_DIR?.trim();
  return dir !== undefined && dir !== "" && path.resolve(cwd, dir) !== path.resolve(cwd, "data");
}

/** The next id after the highest `<prefix>-<n>`, padded to `width` digits: t-045 gives t-046. */
export function nextId(prefix: string, ids: readonly string[], width: number): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const highest = ids.reduce((max, id) => Math.max(max, Number(pattern.exec(id)?.[1] ?? 0)), 0);
  return `${prefix}-${String(highest + 1).padStart(width, "0")}`;
}

/** 11:00 Dhaka on the day, the hour the ledger's own rows use, so the row falls on that Dhaka day. */
const dhakaMorning = (ymd: string): string => `${ymd}T05:00:00.000Z`;

/**
 * The edit an approval makes for one reconciliation row: a broker trade missing from the ledger becomes a
 * transaction (its commission as fees_bdt, so it then matches with no fee difference); a bank deposit missing from
 * the contributions becomes a contribution. A commission difference, a ledger trade with no broker row and a
 * contribution with no bank deposit are manual checks for the owner: code writes nothing.
 */
export function editFor(row: Row, existing: { transactionIds: readonly string[]; contributionIds: readonly string[] }): LedgerEdit {
  const date = str(row.date);
  switch (str(row.kind)) {
    case "broker_only_trade": {
      const side = str(row.side);
      if (side !== "buy" && side !== "sell") return { op: "manual_check", reason: `the broker row ${str(row.ref)} has side ${JSON.stringify(side)}` };
      return {
        op: "add_transaction",
        row: {
          id: nextId("t", existing.transactionIds, 3),
          created_at: dhakaMorning(date),
          symbol: normalizeSymbol(str(row.symbol)),
          side,
          quantity: Number(row.quantity),
          price_per_share: Number(row.price),
          category: null,
          fees_bdt: typeof row.commission_bdt === "number" ? row.commission_bdt : 0,
          account_type: "long_term",
        },
      };
    }
    case "bank_only_deposit":
      return {
        op: "add_contribution",
        row: { id: nextId("c", existing.contributionIds, 2), created_at: dhakaMorning(date), amount_bdt: Number(row.amount_bdt), note: `Bank deposit ${str(row.ref)}, added on the owner's approval` },
      };
    default:
      return { op: "manual_check", reason: proposedFix(row) };
  }
}
