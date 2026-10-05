/**
 * The Postgres tables `npm run db:load` creates. Column names are exactly the
 * JSON and CSV field names, so the files load without renaming.
 *
 * tradeflow_ledger holds the owner's own records and the market data;
 * tradeflow_external holds what came from outside: the broker's and the
 * bank's files, announcements and company fundamentals.
 */

export const LEDGER_DB = "tradeflow_ledger";
export const EXTERNAL_DB = "tradeflow_external";
export const READ_ONLY_ROLE = "zetaris_ro";

// [column, type]. The first column of `key` is the primary key when given.
export const TABLES = [
  { db: LEDGER_DB, name: "instruments", key: ["symbol"], columns: [["symbol", "text"], ["name", "text"], ["sector", "text"]] },
  {
    db: LEDGER_DB,
    name: "bars",
    key: ["symbol", "bar_date"],
    columns: [["symbol", "text"], ["bar_date", "date"], ["open", "numeric"], ["high", "numeric"], ["low", "numeric"], ["close", "numeric"], ["volume", "bigint"]],
  },
  {
    db: LEDGER_DB,
    name: "transactions",
    key: ["id"],
    columns: [
      ["id", "text"], ["created_at", "timestamptz"], ["symbol", "text"], ["side", "text"], ["quantity", "bigint"],
      ["price_per_share", "numeric"], ["category", "text"], ["fees_bdt", "numeric"], ["account_type", "text"],
    ],
  },
  { db: LEDGER_DB, name: "contributions", key: ["id"], columns: [["id", "text"], ["created_at", "timestamptz"], ["amount_bdt", "numeric"], ["note", "text"]] },
  { db: LEDGER_DB, name: "rule_settings", columns: [["max_position_weight_pct", "numeric"], ["sector_tolerance_pct", "numeric"]] },
  { db: LEDGER_DB, name: "sector_targets", key: ["sector"], columns: [["sector", "text"], ["target_percent", "numeric"]] },
  {
    db: LEDGER_DB,
    name: "trade_plans",
    key: ["id"],
    columns: [
      ["id", "text"], ["created_at", "timestamptz"], ["symbol", "text"], ["side", "text"], ["target_price", "numeric"],
      ["quantity_shares", "bigint"], ["note", "text"], ["executed", "boolean"],
    ],
  },
  {
    db: LEDGER_DB,
    name: "corporate_actions",
    key: ["id"],
    columns: [
      ["id", "text"], ["symbol", "text"], ["kind", "text"], ["record_date", "date"], ["paid_on", "date"],
      ["cash_per_share_bdt", "numeric"], ["bonus_ratio", "numeric"], ["announcement_id", "text"],
    ],
  },
  { db: LEDGER_DB, name: "index_bars", key: ["index", "bar_date"], columns: [["index", "text"], ["bar_date", "date"], ["close", "numeric"]] },
  { db: LEDGER_DB, name: "sector_index_bars", key: ["sector", "bar_date"], columns: [["sector", "text"], ["bar_date", "date"], ["close", "numeric"]] },
  {
    db: LEDGER_DB,
    name: "journal",
    key: ["id"],
    columns: [
      ["id", "text"], ["transaction_id", "text"], ["created_at", "timestamptz"], ["thesis", "text"], ["horizon", "text"],
      ["exit_condition", "text"], ["tags", "text[]"],
    ],
  },
  {
    db: LEDGER_DB,
    name: "profile",
    columns: [
      ["display_name", "text"], ["base_currency", "text"], ["risk_tolerance", "text"], ["review_day", "text"],
      ["investment_goal", "text"], ["excluded_sectors", "text[]"], ["notes", "text"],
    ],
  },
  {
    db: EXTERNAL_DB,
    name: "broker_statement",
    key: ["broker_ref"],
    columns: [
      ["broker_ref", "text"], ["trade_date", "date"], ["symbol", "text"], ["side", "text"], ["quantity", "bigint"],
      ["price", "numeric"], ["commission_bdt", "numeric"], ["settlement_date", "date"],
    ],
  },
  { db: EXTERNAL_DB, name: "bank_deposits", key: ["bank_ref"], columns: [["bank_ref", "text"], ["value_date", "date"], ["amount_bdt", "numeric"], ["narration", "text"]] },
  {
    db: EXTERNAL_DB,
    name: "announcements",
    key: ["id"],
    columns: [
      ["id", "text"], ["symbol", "text"], ["published_at", "timestamptz"], ["category", "text"], ["title", "text"],
      ["body", "text"], ["price_sensitive", "boolean"],
    ],
  },
  {
    db: EXTERNAL_DB,
    name: "fundamentals",
    key: ["symbol", "period_end"],
    columns: [
      ["symbol", "text"], ["period_end", "date"], ["reported_on", "date"], ["eps_bdt", "numeric"],
      ["nav_per_share_bdt", "numeric"], ["revenue_mn_bdt", "numeric"], ["net_profit_mn_bdt", "numeric"],
    ],
  },
];

/** A double-quoted identifier, so names such as `index` are safe. */
export function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function createTableSql(table) {
  const cols = table.columns.map(([name, type]) => `  ${ident(name)} ${type}`);
  if (table.key) cols.push(`  PRIMARY KEY (${table.key.map(ident).join(", ")})`);
  return `CREATE TABLE ${ident(table.name)} (\n${cols.join(",\n")}\n)`;
}

/** One parameterised INSERT for `rows`, with $1.. placeholders in column order. */
export function insertSql(table, rows) {
  const names = table.columns.map(([n]) => n);
  const values = [];
  const tuples = rows.map((row) => `(${names.map((n) => (values.push(row[n] ?? null), `$${values.length}`)).join(", ")})`);
  return { text: `INSERT INTO ${ident(table.name)} (${names.map(ident).join(", ")}) VALUES ${tuples.join(", ")}`, values };
}

/** RFC 4180 CSV into objects keyed by the header line, the same rules as src/lib/sources.ts. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
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
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] === undefined || r[i] === "" ? null : r[i]])));
}

/** The rows for each table, from the JSON and CSV files already read. */
export function rowsFor(table, files) {
  switch (table.name) {
    case "rule_settings":
      return [{ max_position_weight_pct: files.rules.max_position_weight_pct, sector_tolerance_pct: files.rules.sector_tolerance_pct }];
    case "sector_targets":
      return files.rules.sector_targets;
    case "trade_plans":
      return files.rules.trade_plans;
    case "profile":
      return files.profile ? [files.profile] : [];
    case "broker_statement":
    case "bank_deposits":
      return parseCsv(files[table.name] ?? "");
    default:
      return files[table.name] ?? [];
  }
}
