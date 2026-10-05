import { readSourceText } from "@/lib/store";

/** A line of the broker's trade confirmation statement. */
export type BrokerStatementRow = {
  broker_ref: string;
  trade_date: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission_bdt: number;
  /** T+2 trading days after `trade_date`. */
  settlement_date: string;
};

/** A credit on the bank account that funds the brokerage account. */
export type BankDepositRow = {
  bank_ref: string;
  value_date: string;
  amount_bdt: number;
  narration: string;
};

/**
 * RFC 4180 CSV: comma separated, fields may be quoted, `""` is a quote inside
 * a quoted field, and a quoted field may hold commas and line breaks. Blank
 * lines are dropped. Returns every row, header included.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** Rows as objects keyed by the header line. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function toBrokerRows(records: Record<string, string>[]): BrokerStatementRow[] {
  return records.map((r) => ({
    broker_ref: r.broker_ref,
    trade_date: r.trade_date,
    symbol: r.symbol.toUpperCase(),
    side: r.side.toLowerCase() === "sell" ? "sell" : "buy",
    quantity: Number(r.quantity),
    price: Number(r.price),
    commission_bdt: Number(r.commission_bdt),
    settlement_date: r.settlement_date,
  }));
}

export function toBankRows(records: Record<string, string>[]): BankDepositRow[] {
  return records.map((r) => ({
    bank_ref: r.bank_ref,
    value_date: r.value_date,
    amount_bdt: Number(r.amount_bdt),
    narration: r.narration,
  }));
}

export async function loadBrokerStatement(): Promise<BrokerStatementRow[]> {
  return toBrokerRows(csvRecords(await readSourceText("broker_statement")));
}

export async function loadBankDeposits(): Promise<BankDepositRow[]> {
  return toBankRows(csvRecords(await readSourceText("bank_deposits")));
}
