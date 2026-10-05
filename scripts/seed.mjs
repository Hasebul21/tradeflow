#!/usr/bin/env node
/**
 * Writes the synthetic data set into data/ (see scripts/seed-data.mjs).
 *
 * The data ends on SEED_END_DATE (default 2026-10-01, a Thursday). A date that
 * falls on a Friday or Saturday ends on the Thursday before. The seed is
 * fixed, so two runs with the same end date write identical files.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_END_DATE, generate } from "./seed-data.mjs";

// Values already in the environment win over .env.
try {
  process.loadEnvFile?.(".env");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

const DATA_DIR = path.resolve(process.cwd(), process.env.TRADEFLOW_DATA_DIR?.trim() || "data");
const END_DATE = process.env.SEED_END_DATE?.trim() || DEFAULT_END_DATE;

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(END_DATE)) throw new Error("SEED_END_DATE must be YYYY-MM-DD.");
  const { days, json, csv } = generate(END_DATE);

  await fs.mkdir(path.join(DATA_DIR, "sources"), { recursive: true });
  await Promise.all([
    ...Object.entries(json).map(([name, value]) =>
      fs.writeFile(path.join(DATA_DIR, `${name}.json`), JSON.stringify(value, null, 2) + "\n"),
    ),
    ...Object.entries(csv).map(([name, text]) => fs.writeFile(path.join(DATA_DIR, "sources", `${name}.csv`), text)),
  ]);

  console.log(`Wrote ${DATA_DIR}`);
  console.log(`  sessions: ${days.length} (${days[0]} to ${days[days.length - 1]})`);
  for (const [name, value] of Object.entries(json)) {
    if (Array.isArray(value)) console.log(`  ${name}: ${value.length}`);
  }
  console.log(`  trade plans: ${json.rules.trade_plans.length}`);
  for (const [name, text] of Object.entries(csv)) console.log(`  sources/${name}.csv: ${text.trim().split("\n").length - 1} rows`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
