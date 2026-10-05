import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../scripts/seed-data.mjs";
import { attribute } from "@/lib/attribution";
import { loadAnnouncements } from "@/lib/announcements";
import { loadFundamentals, summariseFundamentals } from "@/lib/fundamentals";
import { loadJournal } from "@/lib/journal";
import { barsBySymbol } from "@/lib/market/quotes";
import { loadSectorIndexBars } from "@/lib/market/sector-index";
import { buildPortfolioView, dataUpTo, loadPortfolioData, type PortfolioData } from "@/lib/portfolio-view";
import { reconcile } from "@/lib/reconcile";
import { loadBankDeposits, loadBrokerStatement } from "@/lib/sources";
import { previewTrade } from "@/lib/what-if";

/**
 * The story planted in data/ by scripts/seed-data.mjs, checked through the
 * app's own code. If one of these fails after a change to the seed, the
 * story in data/README.md no longer holds.
 */
const END = "2026-10-01";
const WEEK_TO = { bankRally: "2026-09-17", gpExDividend: "2026-09-24", pharmaResults: "2026-10-01" };

let data: PortfolioData;
let sectorBars: Awaited<ReturnType<typeof loadSectorIndexBars>>;

beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  data = await loadPortfolioData();
  sectorBars = await loadSectorIndexBars();
});

function weekAttribution(asOf: string) {
  const v = buildPortfolioView(data, asOf);
  const upTo = dataUpTo(data, asOf);
  return attribute({
    holdings: v.holdings,
    barsBySymbol: barsBySymbol(upTo.bars),
    indexBars: upTo.indexBars,
    sectorIndexBars: sectorBars.filter((b) => b.bar_date <= asOf),
  });
}

describe("the seeded data", () => {
  it("is what the seed generates for the default end date", async () => {
    const { json, csv } = generate(END);
    for (const [name, value] of Object.entries(json)) {
      const text = await readFile(path.join(process.cwd(), "data", `${name}.json`), "utf8");
      expect(text, name).toBe(JSON.stringify(value, null, 2) + "\n");
    }
    for (const [name, text] of Object.entries(csv as Record<string, string>)) {
      expect(await readFile(path.join(process.cwd(), "data", "sources", `${name}.csv`), "utf8"), name).toBe(text);
    }
  });

  it("ends on Thursday 1 October 2026", () => {
    expect(data.bars.reduce((m, b) => (b.bar_date > m ? b.bar_date : m), "")).toBe(END);
  });
});

describe("week to 17 Sep: the bank rally", () => {
  it("lifts every bank holding in line with the bank sector index", () => {
    const a = weekAttribution(WEEK_TO.bankRally);
    const banks = a.holdings.filter((h) => h.sector === "Bank");
    expect(banks.map((h) => h.symbol).sort()).toEqual(["BRACBANK", "CITYBANK", "EBL"]);
    for (const h of banks) {
      expect(h.sectorChangePct ?? 0).toBeGreaterThan(4);
      expect(h.comparison, h.symbol).toBe("in line with sector");
    }
  });

  it("beats DSEX that week", () => {
    expect(weekAttribution(WEEK_TO.bankRally).differencePts ?? 0).toBeGreaterThan(0.5);
  });
});

describe("week to 24 Sep: GP goes ex-dividend", () => {
  it("has the declaration, the record date in the week and a price drop", async () => {
    const gp = data.actions.find((a) => a.symbol === "GP");
    expect(gp?.kind).toBe("cash_dividend");
    expect(gp?.record_date).toBe("2026-09-21");
    const announcements = await loadAnnouncements();
    expect(announcements.find((a) => a.id === gp?.announcement_id)?.category).toBe("dividend_declaration");
    const move = weekAttribution(WEEK_TO.gpExDividend).holdings.find((h) => h.symbol === "GP");
    expect(move?.changePct ?? 0).toBeLessThan(-3);
  });

  it("entitles the owner to GP's dividend, still to be paid on 1 Oct", () => {
    const d = buildPortfolioView(data, END).dividends.find((x) => x.symbol === "GP");
    expect(d?.shares).toBe(240);
    expect(d?.amountBdt).toBe(3000);
    expect(d?.paid).toBe(false);
  });
});

describe("week to 1 Oct: pharma results", () => {
  it("BXPHARMA falls well below its sector after lower profit", async () => {
    const a = weekAttribution(WEEK_TO.pharmaResults);
    const bx = a.holdings.find((h) => h.symbol === "BXPHARMA");
    expect(bx?.changePct ?? 0).toBeLessThan(-8);
    expect(bx?.versusSectorPts ?? 0).toBeLessThan(-6);
    expect(bx?.comparison).toBe("stock-specific");
    const results = (await loadAnnouncements()).find(
      (x) => x.symbol === "BXPHARMA" && x.category === "earnings" && x.published_at === "2026-09-27T05:00:00.000Z",
    );
    expect(results?.price_sensitive).toBe(true);
    expect(results?.title).toMatch(/lower/);
  });

  it("SQURPHARMA rises after good results and crosses the 25% limit", () => {
    const over = (asOf: string) =>
      buildPortfolioView(data, asOf).findings.some((f) => f.kind === "max_position_weight" && f.symbol === "SQURPHARMA");
    expect(over(WEEK_TO.gpExDividend)).toBe(false);
    expect(over(WEEK_TO.pharmaResults)).toBe(true);
    const sq = weekAttribution(WEEK_TO.pharmaResults).holdings.find((h) => h.symbol === "SQURPHARMA");
    expect(sq?.changePct ?? 0).toBeGreaterThan(1);
    expect(sq?.comparison).toBe("stock-specific");
  });

  it("labels only BXPHARMA and SQURPHARMA stock-specific", () => {
    const specific = weekAttribution(WEEK_TO.pharmaResults).holdings.filter((h) => h.comparison === "stock-specific").map((h) => h.symbol);
    expect(specific.sort()).toEqual(["BXPHARMA", "SQURPHARMA"]);
  });

  it("trails DSEX that week", () => {
    expect(weekAttribution(WEEK_TO.pharmaResults).differencePts ?? 0).toBeLessThan(-0.5);
  });

  it("the fundamentals agree: BXPHARMA's EPS fell on the quarter, SQURPHARMA's rose", async () => {
    const rows = await loadFundamentals();
    expect(summariseFundamentals(rows, "BXPHARMA", END, null).epsChangePct ?? 0).toBeLessThan(0);
    expect(summariseFundamentals(rows, "SQURPHARMA", END, null).epsChangePct ?? 0).toBeGreaterThan(0);
    expect(summariseFundamentals(rows, "BXPHARMA", "2026-09-26", null).latest?.period_end).toBe("2026-03-31");
  });
});

describe("a rule broken two weeks running", () => {
  it("pharma is above its target on both 24 Sep and 1 Oct", () => {
    for (const asOf of [WEEK_TO.gpExDividend, WEEK_TO.pharmaResults]) {
      const f = buildPortfolioView(data, asOf).findings.find((x) => x.kind === "sector_target");
      expect(f && f.kind === "sector_target" ? [f.sector, f.deltaPct > 5] : null, asOf).toEqual(["Pharmaceuticals & Chemicals", true]);
    }
  });
});

describe("the bonus issue", () => {
  it("adds BRACBANK shares and lowers the average cost, with no cash moving", () => {
    const bonus = data.actions.find((a) => a.kind === "stock_dividend");
    expect(bonus?.symbol).toBe("BRACBANK");
    const credited = bonus?.paid_on ?? "";
    const dayBefore = new Date(Date.parse(`${credited}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const before = buildPortfolioView(data, dayBefore).holdings.find((h) => h.symbol === "BRACBANK");
    const after = buildPortfolioView(data, credited).holdings.find((h) => h.symbol === "BRACBANK");
    expect((after?.shares ?? 0) - (before?.shares ?? 0)).toBe(120);
    expect(after?.avgPrice ?? 0).toBeLessThan(before?.avgPrice ?? 0);
    expect(after?.totalCost).toBeCloseTo(before?.totalCost ?? 0, 2);
    expect(data.contributions.some((c) => c.created_at.slice(0, 10) === credited)).toBe(false);
  });
});

describe("planted test cases", () => {
  it("has a confirmed, a contradicted and an undecided thesis", async () => {
    const journal = await loadJournal();
    const byTrade = new Map(data.transactions.map((t) => [t.id, t]));
    const thesisFor = (symbol: string, text: RegExp) =>
      journal.find((e) => byTrade.get(e.transaction_id)?.symbol === symbol && text.test(e.thesis));

    expect(thesisFor("BATBC", /for the dividend/)).toBeDefined();
    expect(buildPortfolioView(data, END).dividends.find((d) => d.symbol === "BATBC")?.paid).toBe(true);

    expect(thesisFor("BXPHARMA", /expecting earnings growth/)).toBeDefined();

    expect(thesisFor("LHBL", /after the monsoon/)?.exit_condition).toMatch(/15%/);
    expect(thesisFor("SQURPHARMA", /Adding to Square/)).toBeDefined();
    expect(journal.some((e) => e.exit_condition === "Trim if it goes above 25% of the portfolio.")).toBe(true);
  });

  it("has a trade plan that would break a rule and one that would not", () => {
    const plans = data.rules.trade_plans.filter((p) => !p.executed);
    const run = (symbol: string) => {
      const p = plans.find((x) => x.symbol === symbol && x.side === "buy");
      if (!p) throw new Error(`no ${symbol} plan`);
      const r = previewTrade(data, END, { symbol, side: p.side, quantity: p.quantity_shares ?? 0, price: p.target_price });
      if (!r.ok) throw new Error(r.error);
      return r.newFindings;
    };
    expect(run("WALTONHIL").map((f) => f.kind)).toEqual(["sector_target"]);
    expect(run("EBL")).toEqual([]);
  });

  it("reconciliation finds exactly the four planted discrepancies", async () => {
    const r = reconcile({
      broker: await loadBrokerStatement(),
      ledger: data.transactions,
      bank: await loadBankDeposits(),
      contributions: data.contributions,
    });
    expect(r.issueCount).toBe(4);
    expect(r.trades.mismatched.map((p) => [p.ledger.id, p.differences.map((d) => d.field)])).toEqual([["t-021", ["commission_bdt"]]]);
    expect(r.trades.mismatched[0].differences[0].broker - r.trades.mismatched[0].differences[0].ledger).toBeCloseTo(1.2, 2);
    expect(r.trades.ledgerOnly.map((t) => [t.id, t.symbol])).toEqual([["t-030", "LHBL"]]);
    expect(r.trades.brokerOnly.map((b) => [b.symbol, b.quantity])).toEqual([["OLYMPIC", 20]]);
    expect(r.deposits.bankOnly.map((b) => b.amount_bdt)).toEqual([25000]);
    expect(r.deposits.contributionsOnly).toEqual([]);
    expect(r.trades.matched).toHaveLength(43);
  });
});
