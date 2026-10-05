import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JournalEntry } from "@/lib/data-types";
import type { TransactionRow } from "@/lib/portfolio";
import {
  appendJournalEntry,
  isJournalHorizon,
  journalByTransaction,
  journalForSymbol,
  loadJournal,
  parseTags,
} from "./journal";

function entry(id: string, transaction_id: string, created_at: string): JournalEntry {
  return { id, transaction_id, created_at, thesis: "why", horizon: "months", exit_condition: null, tags: [] };
}

function trade(id: string, symbol: string): TransactionRow {
  return { id, created_at: "2026-06-01T05:00:00.000Z", symbol, side: "buy", quantity: 1, price_per_share: 1, category: null };
}

const entries = [
  entry("j-002", "t-1", "2026-06-02T07:00:00.000Z"),
  entry("j-001", "t-1", "2026-06-01T07:00:00.000Z"),
  entry("j-003", "t-2", "2026-06-03T07:00:00.000Z"),
  entry("j-004", "t-gone", "2026-06-04T07:00:00.000Z"),
];

describe("journal", () => {
  it("groups entries by transaction, oldest first", () => {
    const grouped = journalByTransaction(entries);
    expect(grouped.get("t-1")?.map((e) => e.id)).toEqual(["j-001", "j-002"]);
    expect(grouped.get("t-2")?.map((e) => e.id)).toEqual(["j-003"]);
  });

  it("finds entries by the symbol of their trade", () => {
    const ledger = [trade("t-1", "GP"), trade("t-2", "BXPHARMA")];
    expect(journalForSymbol(entries, ledger, "gp").map((e) => e.id)).toEqual(["j-002", "j-001"]);
    expect(journalForSymbol(entries, ledger, "EBL")).toEqual([]);
  });

  it("parses tags and horizons", () => {
    expect(parseTags(" Dividend, defensive,,dividend ")).toEqual(["dividend", "defensive"]);
    expect(isJournalHorizon("years")).toBe(true);
    expect(isJournalHorizon("days")).toBe(false);
  });

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tradeflow-"));
    process.env.TRADEFLOW_DATA_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.TRADEFLOW_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty and loads appended entries newest first", async () => {
    expect(await loadJournal()).toEqual([]);
    await appendJournalEntry(entries[1]);
    await appendJournalEntry(entries[0]);
    expect((await loadJournal()).map((e) => e.id)).toEqual(["j-002", "j-001"]);
  });
});
