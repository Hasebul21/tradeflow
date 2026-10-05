import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDir, readJson, writeJson } from "./store";
import { appendTransaction, loadTransactions } from "./transactions";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-"));
  process.env.TRADEFLOW_DATA_DIR = dir;
});

afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("resolves the data dir from the environment", () => {
    expect(dataDir()).toBe(path.resolve(dir));
  });

  it("returns the fallback when a file is missing, and round-trips a write", async () => {
    expect(await readJson("rules", { a: 1 })).toEqual({ a: 1 });
    await writeJson("rules", { max_position_weight_pct: 30 });
    expect(await readJson("rules", null)).toEqual({ max_position_weight_pct: 30 });
    expect(await readFile(path.join(dir, "rules.json"), "utf8")).toMatch(/\n$/);
  });

  it("appends transactions and keeps them in ledger order", async () => {
    await appendTransaction({
      id: "b",
      created_at: "2026-10-02T05:00:00.000Z",
      symbol: "GP",
      side: "buy",
      quantity: 10,
      price_per_share: 300,
      category: null,
      fees_bdt: 12,
    });
    await appendTransaction({
      id: "a",
      created_at: "2026-10-01T05:00:00.000Z",
      symbol: "GP",
      side: "buy",
      quantity: 5,
      price_per_share: 290,
      category: null,
      fees_bdt: 5.8,
    });
    const rows = await loadTransactions();
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
