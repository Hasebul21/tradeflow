import { constants, promises as fs } from "node:fs";
import { dataDir, readJson, readSourceText, type DataFile, type SourceFile } from "@/lib/store";

export const JSON_FILES: readonly DataFile[] = [
  "instruments",
  "bars",
  "transactions",
  "contributions",
  "rules",
  "announcements",
  "corporate_actions",
  "index_bars",
  "sector_index_bars",
  "fundamentals",
  "journal",
  "profile",
];
export const SOURCE_FILES: readonly SourceFile[] = ["broker_statement", "bank_deposits"];

export type Health = { status: "ok"; data_dir_readable: boolean; files: Record<string, number | null> };

/** Rows in an array file, 1 for a single document, null when the file is missing or unreadable. */
async function jsonRows(name: DataFile): Promise<number | null> {
  try {
    const value = await readJson<unknown>(name, null);
    if (value === null) return null;
    return Array.isArray(value) ? value.length : 1;
  } catch {
    return null;
  }
}

async function csvRows(name: SourceFile): Promise<number | null> {
  try {
    const text = await readSourceText(name, "");
    return text ? text.trim().split("\n").length - 1 : null;
  } catch {
    return null;
  }
}

/** A quick check that the data folder can be read, with a row count per file. */
export async function health(): Promise<Health> {
  let readable = true;
  try {
    await fs.access(dataDir(), constants.R_OK);
  } catch {
    readable = false;
  }
  const json = await Promise.all(JSON_FILES.map(async (n) => [n, await jsonRows(n)] as const));
  const csv = await Promise.all(SOURCE_FILES.map(async (n) => [`sources/${n}`, await csvRows(n)] as const));
  return { status: "ok", data_dir_readable: readable, files: Object.fromEntries([...json, ...csv]) };
}
