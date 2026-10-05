#!/usr/bin/env node
/**
 * Loads data/ into Postgres: `npm run db:load`.
 *
 * Needs DATABASE_URL (any database on the server, such as /postgres). Creates
 * tradeflow_ledger and tradeflow_external if missing, then drops and
 * recreates every table in one transaction per database. With
 * ZETARIS_DB_PASSWORD set, it also creates or updates the login role
 * zetaris_ro, which may connect to both databases and only SELECT.
 *
 * It never prints the connection string or a password.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";
import { EXTERNAL_DB, LEDGER_DB, READ_ONLY_ROLE, TABLES, createTableSql, ident, insertSql, rowsFor } from "./db-schema.mjs";

// Values already in the environment win over .env.
try {
  process.loadEnvFile?.(".env");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

const DATA_DIR = path.resolve(process.cwd(), process.env.TRADEFLOW_DATA_DIR?.trim() || "data");
const BATCH = 500;

const JSON_FILES = [
  "instruments", "bars", "transactions", "contributions", "rules", "corporate_actions",
  "index_bars", "sector_index_bars", "journal", "profile", "announcements", "fundamentals",
];
const CSV_FILES = ["broker_statement", "bank_deposits"];

async function readFiles() {
  const files = {};
  for (const name of JSON_FILES) {
    try {
      files[name] = JSON.parse(await fs.readFile(path.join(DATA_DIR, `${name}.json`), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      files[name] = name === "rules" ? { sector_targets: [], trade_plans: [] } : name === "profile" ? null : [];
    }
  }
  for (const name of CSV_FILES) {
    try {
      files[name] = await fs.readFile(path.join(DATA_DIR, "sources", `${name}.csv`), "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      files[name] = "";
    }
  }
  return files;
}

function urlFor(base, db) {
  const url = new URL(base);
  url.pathname = `/${db}`;
  return url.toString();
}

async function withClient(connectionString, fn) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureDatabases(admin) {
  for (const db of [LEDGER_DB, EXTERNAL_DB]) {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (found.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${ident(db)}`);
      console.log(`Created database ${db}`);
    }
  }
}

/** Drop, create and fill every table of `db` in one transaction. Returns row counts. */
async function loadDatabase(client, db, files) {
  const counts = [];
  await client.query("BEGIN");
  try {
    for (const table of TABLES.filter((t) => t.db === db)) {
      await client.query(`DROP TABLE IF EXISTS ${ident(table.name)} CASCADE`);
      await client.query(createTableSql(table));
      const rows = rowsFor(table, files);
      for (let i = 0; i < rows.length; i += BATCH) await client.query(insertSql(table, rows.slice(i, i + BATCH)));
      const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM ${ident(table.name)}`);
      counts.push([table.name, n]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  return counts;
}

async function ensureReadOnlyRole(admin, password) {
  const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [READ_ONLY_ROLE])).rowCount > 0;
  const verb = exists ? "ALTER" : "CREATE";
  await admin.query(`${verb} ROLE ${ident(READ_ONLY_ROLE)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  for (const db of [LEDGER_DB, EXTERNAL_DB]) await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(READ_ONLY_ROLE)}`);
  console.log(`${exists ? "Updated" : "Created"} role ${READ_ONLY_ROLE}`);
}

async function grantSelect(client) {
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(READ_ONLY_ROLE)}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${ident(READ_ONLY_ROLE)}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ident(READ_ONLY_ROLE)}`);
}

async function main() {
  const base = process.env.DATABASE_URL?.trim();
  if (!base) throw new Error("DATABASE_URL is not set. See .env.example and the README.");
  const password = process.env.ZETARIS_DB_PASSWORD?.trim();
  const files = await readFiles();

  await withClient(base, ensureDatabases);
  for (const db of [LEDGER_DB, EXTERNAL_DB]) {
    const counts = await withClient(urlFor(base, db), (c) => loadDatabase(c, db, files));
    console.log(`${db}:`);
    for (const [name, n] of counts) console.log(`  ${name.padEnd(18)} ${n}`);
  }

  if (!password) {
    console.log(`ZETARIS_DB_PASSWORD is not set, so the read-only role ${READ_ONLY_ROLE} was not created or updated.`);
    return;
  }
  await withClient(base, (admin) => ensureReadOnlyRole(admin, password));
  for (const db of [LEDGER_DB, EXTERNAL_DB]) await withClient(urlFor(base, db), grantSelect);
  console.log(`${READ_ONLY_ROLE} may connect to ${LEDGER_DB} and ${EXTERNAL_DB} and SELECT from their tables.`);
}

main().catch((e) => {
  // pg error messages name the user and database at most; the URL and passwords are never part of them.
  console.error(`db:load failed: ${e.code ? `${e.code} ` : ""}${e.message}`);
  process.exit(1);
});
