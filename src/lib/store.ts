import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * JSON files on disk are the whole database. One file per record type, read
 * on every request and rewritten whole on every change. Small enough for a
 * personal portfolio, and simple enough that any SQL engine can load the same
 * files later.
 */
export type DataFile =
  | "transactions"
  | "bars"
  | "instruments"
  | "contributions"
  | "rules"
  | "announcements"
  | "corporate_actions"
  | "index_bars"
  | "journal"
  | "profile"
  | "fundamentals"
  | "sector_index_bars";

/** CSV files as a broker and a bank would send them, kept in `data/sources/`. Read-only. */
export type SourceFile = "broker_statement" | "bank_deposits";

export function dataDir(): string {
  const raw = process.env.TRADEFLOW_DATA_DIR?.trim();
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), raw || "data");
}

export function dataPath(name: DataFile): string {
  return path.join(dataDir(), `${name}.json`);
}

export function sourcePath(name: SourceFile): string {
  return path.join(dataDir(), "sources", `${name}.csv`);
}

/** The raw text of a source file, or `fallback` when it is missing. */
export async function readSourceText(name: SourceFile, fallback = ""): Promise<string> {
  try {
    return await fs.readFile(sourcePath(name), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

export async function readJson<T>(name: DataFile, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(dataPath(name), "utf8");
    return JSON.parse(text) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

/** Write to a temp file, then rename, so a crash never leaves a half-written file. */
export async function writeJson<T>(name: DataFile, value: T): Promise<void> {
  const file = dataPath(name);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}
