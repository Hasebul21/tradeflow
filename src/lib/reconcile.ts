import type { Contribution } from "@/lib/data-types";
import { dhakaToday } from "@/lib/market/trading-calendar";
import { roundBdt, type TransactionRow } from "@/lib/portfolio";
import type { BankDepositRow, BrokerStatementRow } from "@/lib/sources";
import { normalizeSymbol } from "@/lib/symbol";

/** A broker price within this many taka of the ledger's still counts as the same trade. */
export const PRICE_TOLERANCE_BDT = 0.1;
/** Money amounts closer than this are equal (rounding to the paisa). */
const MONEY_EPSILON = 0.005;

export type FieldDifference = { field: "commission_bdt" | "price"; broker: number; ledger: number };

export type TradePair = { broker: BrokerStatementRow; ledger: TransactionRow; differences: FieldDifference[] };

export type TradeReconciliation = {
  matched: TradePair[];
  /** Matched pairs that differ in a field, such as the commission. */
  mismatched: TradePair[];
  ledgerOnly: TransactionRow[];
  brokerOnly: BrokerStatementRow[];
};

export type DepositReconciliation = {
  matched: { bank: BankDepositRow; contribution: Contribution }[];
  contributionsOnly: Contribution[];
  bankOnly: BankDepositRow[];
};

export type Reconciliation = {
  trades: TradeReconciliation;
  deposits: DepositReconciliation;
  /** Count of every row that needs a look: mismatches plus unmatched rows on either side. */
  issueCount: number;
};

const dayOf = (iso: string) => dhakaToday(new Date(iso));

function differences(b: BrokerStatementRow, t: TransactionRow): FieldDifference[] {
  const out: FieldDifference[] = [];
  const fee = roundBdt(Number(t.fees_bdt ?? 0));
  const price = Number(t.price_per_share);
  if (Math.abs(b.commission_bdt - fee) > MONEY_EPSILON) out.push({ field: "commission_bdt", broker: b.commission_bdt, ledger: fee });
  if (Math.abs(b.price - price) > MONEY_EPSILON) out.push({ field: "price", broker: b.price, ledger: price });
  return out;
}

/**
 * Pairs each broker row with one ledger trade on the same day, symbol, side
 * and quantity, at a price within the tolerance. Each row is used once, in
 * file order. It only reports; it never changes either side.
 */
export function reconcileTrades(
  broker: readonly BrokerStatementRow[],
  ledger: readonly TransactionRow[],
): TradeReconciliation {
  const unused = [...ledger];
  const matched: TradePair[] = [];
  const mismatched: TradePair[] = [];
  const brokerOnly: BrokerStatementRow[] = [];
  for (const b of broker) {
    const i = unused.findIndex(
      (t) =>
        dayOf(t.created_at) === b.trade_date &&
        normalizeSymbol(t.symbol) === normalizeSymbol(b.symbol) &&
        t.side === b.side &&
        Number(t.quantity) === b.quantity &&
        Math.abs(Number(t.price_per_share) - b.price) <= PRICE_TOLERANCE_BDT + 1e-9,
    );
    if (i < 0) {
      brokerOnly.push(b);
      continue;
    }
    const [t] = unused.splice(i, 1);
    const pair = { broker: b, ledger: t, differences: differences(b, t) };
    (pair.differences.length > 0 ? mismatched : matched).push(pair);
  }
  return { matched, mismatched, ledgerOnly: unused, brokerOnly };
}

/** Pairs each bank credit with one contribution on the same Dhaka day for the same amount. */
export function reconcileDeposits(
  bank: readonly BankDepositRow[],
  contributions: readonly Contribution[],
): DepositReconciliation {
  const unused = [...contributions];
  const matched: DepositReconciliation["matched"] = [];
  const bankOnly: BankDepositRow[] = [];
  for (const b of bank) {
    const i = unused.findIndex(
      (c) => dayOf(c.created_at) === b.value_date && Math.abs(c.amount_bdt - b.amount_bdt) <= MONEY_EPSILON,
    );
    if (i < 0) bankOnly.push(b);
    else matched.push({ bank: b, contribution: unused.splice(i, 1)[0] });
  }
  return { matched, contributionsOnly: unused, bankOnly };
}

export function reconcile(args: {
  broker: readonly BrokerStatementRow[];
  ledger: readonly TransactionRow[];
  bank: readonly BankDepositRow[];
  contributions: readonly Contribution[];
}): Reconciliation {
  const trades = reconcileTrades(args.broker, args.ledger);
  const deposits = reconcileDeposits(args.bank, args.contributions);
  return {
    trades,
    deposits,
    issueCount:
      trades.mismatched.length +
      trades.ledgerOnly.length +
      trades.brokerOnly.length +
      deposits.contributionsOnly.length +
      deposits.bankOnly.length,
  };
}
