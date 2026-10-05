import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvRecords, loadBankDeposits, loadBrokerStatement, parseCsv, toBankRows, toBrokerRows } from "./sources";

describe("parseCsv", () => {
  it("splits plain fields and drops blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas, quotes and line breaks inside quoted fields", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,b,c\n1,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("source loaders", () => {
  it("types broker and bank rows", () => {
    const broker = toBrokerRows(
      csvRecords(
        "broker_ref,trade_date,symbol,side,quantity,price,commission_bdt,settlement_date\nBRK-1,2026-09-03,ebl,BUY,300,27.2,32.64,2026-09-07\n",
      ),
    );
    expect(broker).toEqual([
      {
        broker_ref: "BRK-1",
        trade_date: "2026-09-03",
        symbol: "EBL",
        side: "buy",
        quantity: 300,
        price: 27.2,
        commission_bdt: 32.64,
        settlement_date: "2026-09-07",
      },
    ]);
    const bank = toBankRows(csvRecords('bank_ref,value_date,amount_bdt,narration\nBNK-1,2026-09-07,50000,"Transfer, BO linked"\n'));
    expect(bank).toEqual([{ bank_ref: "BNK-1", value_date: "2026-09-07", amount_bdt: 50000, narration: "Transfer, BO linked" }]);
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

  it("returns no rows when the files are missing", async () => {
    expect(await loadBrokerStatement()).toEqual([]);
    expect(await loadBankDeposits()).toEqual([]);
  });
});
