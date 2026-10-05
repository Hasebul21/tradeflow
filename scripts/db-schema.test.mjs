import { describe, expect, it } from "vitest";
import { EXTERNAL_DB, LEDGER_DB, TABLES, createTableSql, ident, insertSql, parseCsv, rowsFor } from "./db-schema.mjs";

describe("db schema", () => {
  it("puts every table in one of the two databases", () => {
    const by = (db) => TABLES.filter((t) => t.db === db).map((t) => t.name);
    expect(by(LEDGER_DB)).toEqual([
      "instruments", "bars", "transactions", "contributions", "rule_settings", "sector_targets",
      "trade_plans", "corporate_actions", "index_bars", "sector_index_bars", "journal", "profile",
    ]);
    expect(by(EXTERNAL_DB)).toEqual(["broker_statement", "bank_deposits", "announcements", "fundamentals"]);
  });

  it("writes CREATE TABLE with quoted names and a primary key", () => {
    const sql = createTableSql(TABLES.find((t) => t.name === "index_bars"));
    expect(sql).toBe('CREATE TABLE "index_bars" (\n  "index" text,\n  "bar_date" date,\n  "close" numeric,\n  PRIMARY KEY ("index", "bar_date")\n)');
    expect(createTableSql(TABLES.find((t) => t.name === "rule_settings"))).not.toMatch(/PRIMARY KEY/);
    expect(ident('a"b')).toBe('"a""b"');
  });

  it("builds a parameterised insert in column order", () => {
    const table = TABLES.find((t) => t.name === "instruments");
    const q = insertSql(table, [{ symbol: "GP", name: "Grameenphone", sector: "Telecommunication" }, { symbol: "EBL", sector: "Bank" }]);
    expect(q.text).toBe('INSERT INTO "instruments" ("symbol", "name", "sector") VALUES ($1, $2, $3), ($4, $5, $6)');
    expect(q.values).toEqual(["GP", "Grameenphone", "Telecommunication", "EBL", null, "Bank"]);
  });

  it("reads quoted CSV fields and maps rules into their tables", () => {
    expect(parseCsv('a,b\n1,"x, y"\n2,\n')).toEqual([{ a: "1", b: "x, y" }, { a: "2", b: null }]);
    const files = { rules: { max_position_weight_pct: 25, sector_tolerance_pct: 5, sector_targets: [{ sector: "Bank", target_percent: 25 }], trade_plans: [] } };
    expect(rowsFor(TABLES.find((t) => t.name === "rule_settings"), files)).toEqual([{ max_position_weight_pct: 25, sector_tolerance_pct: 5 }]);
    expect(rowsFor(TABLES.find((t) => t.name === "sector_targets"), files)).toHaveLength(1);
  });
});
