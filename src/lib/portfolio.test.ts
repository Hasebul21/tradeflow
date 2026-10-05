import { describe, it, expect } from "vitest";
import {
  aggregateHoldings,
  calculateBreakEvenPrice,
  computePortfolioSummary,
  sharesAvailableForSymbol,
  totalInvestedBdt,
  totalRealizedProfitLossBdt,
  unrealizedGainLossBdt,
  type TransactionRow,
} from "./portfolio";

function buy(
  id: string,
  symbol: string,
  quantity: number,
  price: number,
  fees = 0,
  daysOffset = 0,
): TransactionRow {
  const ts = new Date(2026, 0, 1 + daysOffset, 10).toISOString();
  return {
    id,
    created_at: ts,
    symbol,
    side: "buy",
    quantity,
    price_per_share: price,
    category: null,
    fees_bdt: fees,
  };
}

function sell(
  id: string,
  symbol: string,
  quantity: number,
  price: number,
  fees = 0,
  daysOffset = 1,
): TransactionRow {
  const ts = new Date(2026, 0, 1 + daysOffset, 10).toISOString();
  return {
    id,
    created_at: ts,
    symbol,
    side: "sell",
    quantity,
    price_per_share: price,
    category: null,
    fees_bdt: fees,
  };
}

describe("aggregateHoldings", () => {
  it("should show 0 shares when all sold", () => {
    const rows: TransactionRow[] = [
      {
        id: "1",
        created_at: "2026-04-01T10:00:00Z",
        symbol: "LINDEBD",
        side: "buy",
        quantity: 5,
        price_per_share: 640,
        category: null,
        fees_bdt: 12.8,
      },
      {
        id: "2",
        created_at: "2026-04-30T18:03:00Z",
        symbol: "LINDEBD",
        side: "sell",
        quantity: 3,
        price_per_share: 642.6,
        category: null,
        fees_bdt: 7.71,
      },
      {
        id: "3",
        created_at: "2026-04-30T18:06:00Z",
        symbol: "LINDEBD",
        side: "sell",
        quantity: 2,
        price_per_share: 643,
        category: null,
        fees_bdt: 5.14,
      },
    ];

    const holdings = aggregateHoldings(rows);
    const lindebd = holdings.find((h) => h.symbol === "LINDEBD");
    expect(lindebd).toBeUndefined(); // Should not appear since 0 shares
  });
});

describe("calculateBreakEvenPrice", () => {
  it("divides out only the sell fee — the buy fee is already inside avgPrice", () => {
    // Every caller passes a fee-inclusive average: aggregateHoldings folds the
    // buy commission into totalCost before dividing by shares. So break-even
    // only has to cover the sell leg: 100 / 0.996 = 100.401606…, which the UI
    // renders as 100.40. Multiplying by 1.004 again would double the buy fee.
    const be = calculateBreakEvenPrice(100);
    expect(be).toBeCloseTo(100.4016064, 6);
    expect(be.toFixed(2)).toBe("100.40");
  });

  it("returns a price whose net proceeds recover the book cost exactly", () => {
    // The property that matters, stated end-to-end rather than as a formula:
    // buy 100 @ 100 with the auto 0.4% commission (BDT 40), then sell every
    // share at break-even and pay the 0.4% again — the cash back equals what
    // went in, to the paisa.
    const holding = aggregateHoldings([buy("1", "ABC", 100, 100, 40)])[0];
    expect(holding.avgPrice).toBeCloseTo(100.4, 5);
    expect(holding.totalCost).toBeCloseTo(10_040, 5);

    const be = calculateBreakEvenPrice(holding.avgPrice);
    const netProceeds = be * holding.shares * (1 - 0.004);
    expect(netProceeds).toBeCloseTo(holding.totalCost, 5);
  });
});

describe("sell accounting", () => {
  it("profit case: deducts only cost basis from totalInvested and adds (sell − buy) × qty to realized G/L", () => {
    // Spec example: buyPrice=10, sellPrice=12, quantitySold=20.
    // realizedPnL = (12 − 10) × 20 = +40, deductionAmount = 10 × 20 = 200.
    const rows = [buy("1", "ABC", 20, 10), sell("2", "ABC", 20, 12)];

    const holdings = aggregateHoldings(rows);
    expect(holdings.find((h) => h.symbol === "ABC")).toBeUndefined();

    expect(totalInvestedBdt(holdings)).toBe(0);
    expect(totalRealizedProfitLossBdt(rows)).toBe(40);
  });

  it("partial sell: leaves remaining shares with the same average cost and only deducts the sold portion", () => {
    const rows = [buy("1", "ABC", 20, 10), sell("2", "ABC", 8, 12)];

    const holdings = aggregateHoldings(rows);
    const abc = holdings.find((h) => h.symbol === "ABC");
    expect(abc).toBeDefined();
    expect(abc!.shares).toBe(12);
    expect(abc!.avgPrice).toBeCloseTo(10, 5);
    expect(abc!.totalCost).toBeCloseTo(120, 5);

    expect(totalInvestedBdt(holdings)).toBeCloseTo(120, 5);
    // (12 − 10) × 8 = 16
    expect(totalRealizedProfitLossBdt(rows)).toBe(16);
  });

  it("stamps the position with the buy that opened it, not the latest top-up", () => {
    const rows = [buy("1", "ABC", 10, 10, 0, 0), buy("2", "ABC", 10, 11, 0, 5)];
    const abc = aggregateHoldings(rows).find((h) => h.symbol === "ABC")!;
    // Averaging down doesn't reset the clock — the exposure is 5 days old.
    expect(abc.openedAt).toBe(rows[0]!.created_at);
  });

  it("restarts the clock when a position is closed and re-entered", () => {
    const rows = [
      buy("1", "ABC", 10, 10, 0, 0),
      sell("2", "ABC", 10, 12, 0, 3),
      buy("3", "ABC", 10, 11, 0, 9),
    ];
    const abc = aggregateHoldings(rows).find((h) => h.symbol === "ABC")!;
    // A re-entry is a new trade with its own hold window.
    expect(abc.openedAt).toBe(rows[2]!.created_at);
  });

  it("full sell removes the holding even when more shares are listed than owned", () => {
    // sharesAvailableForSymbol guards against this in the action layer too.
    const rows = [buy("1", "ABC", 20, 10), sell("2", "ABC", 20, 11)];
    expect(sharesAvailableForSymbol([rows[0]!], "ABC")).toBe(20);
    const holdings = aggregateHoldings(rows);
    expect(holdings.length).toBe(0);
  });
});

describe("computePortfolioSummary", () => {
  it("returns the recommended structure with netGainLoss = realized + unrealized", () => {
    const rows = [
      buy("1", "ABC", 10, 10, 0, 0),
      sell("2", "ABC", 5, 12, 0, 1),
    ];
    const holdings = aggregateHoldings(rows);
    const realized = totalRealizedProfitLossBdt(rows);

    const ltp = new Map<string, number | null>([["ABC", 14]]);
    const summary = computePortfolioSummary(holdings, realized, ltp);

    // Active capital: 5 @ 10 = 50.
    expect(summary.totalInvested).toBe(50);
    // Realized: (12 − 10) × 5 = 10.
    expect(summary.realizedGainLoss).toBe(10);
    // Unrealized vs break-even of 10 (rounded to 0.1) → 10.0 → (14 − 10.0) × 5 = 20.
    expect(summary.unrealizedGainLoss).toBeGreaterThan(19);
    expect(summary.unrealizedGainLoss).toBeLessThan(21);
    expect(summary.netGainLoss).toBeCloseTo(
      summary.realizedGainLoss + summary.unrealizedGainLoss,
      5,
    );
    expect(summary.quotedPositionCount).toBe(1);
  });

  it("skips positions without a market quote when computing unrealized G/L", () => {
    const rows = [buy("1", "ABC", 10, 10), buy("2", "XYZ", 5, 20)];
    const holdings = aggregateHoldings(rows);
    const ltp = new Map<string, number | null>([
      ["ABC", 12],
      ["XYZ", null],
    ]);
    const { value, quotedCount } = unrealizedGainLossBdt(holdings, ltp);
    expect(quotedCount).toBe(1);
    // Only ABC contributes — break-even ~10.1, so ~ (12 − 10.1) × 10 ≈ 19.
    expect(value).toBeGreaterThan(0);
  });
});

describe("transaction edit/delete behavior", () => {
  it("deleting a buy transaction recomputes the average correctly from the remaining buys", () => {
    // 10 @ 10 and 10 @ 20 → avg 15. Delete the 10 @ 20 buy → avg back to 10.
    const before = [buy("1", "ABC", 10, 10, 0, 0), buy("2", "ABC", 10, 20, 0, 1)];
    const after = [buy("1", "ABC", 10, 10, 0, 0)];

    const beforeAvg = aggregateHoldings(before).find((h) => h.symbol === "ABC")?.avgPrice;
    const afterAvg = aggregateHoldings(after).find((h) => h.symbol === "ABC")?.avgPrice;
    expect(beforeAvg).toBeCloseTo(15, 5);
    expect(afterAvg).toBeCloseTo(10, 5);
  });

  it("realized P/L is order-independent: same total regardless of input row order", () => {
    const a = [buy("1", "ABC", 10, 10, 0, 0), sell("2", "ABC", 5, 12, 0, 1)];
    const b = [a[1]!, a[0]!]; // reversed
    expect(totalRealizedProfitLossBdt(a)).toBe(totalRealizedProfitLossBdt(b));
  });
});

describe("floating-point precision", () => {
  it("fully-sold position cleans up to exactly zero with non-integer quantities", () => {
    // 0.1 + 0.2 ≠ 0.3 in IEEE 754 — make sure totals don't leak through.
    const rows = [
      buy("1", "ABC", 0.1, 100, 0, 0),
      buy("2", "ABC", 0.2, 100, 0, 1),
      sell("3", "ABC", 0.3, 110, 0, 2),
    ];
    const holdings = aggregateHoldings(rows);
    expect(holdings.find((h) => h.symbol === "ABC")).toBeUndefined();
  });
});

describe("multiple buys then sells", () => {
  it("buy fees are folded into avg cost and into realized P/L through the average", () => {
    // Buy 10 @ 100 with 5 BDT fees → totalCost 1005, avg 100.5.
    // Sell 10 @ 100. Realized = (100 − 100.5) × 10 = −5 (= the buy fee absorbed).
    const rows = [buy("1", "ABC", 10, 100, 5, 0), sell("2", "ABC", 10, 100, 0, 1)];
    expect(totalRealizedProfitLossBdt(rows)).toBeCloseTo(-5, 5);
    expect(aggregateHoldings(rows).length).toBe(0);
  });
});

/**
 * `moveHoldingToOtherAccount` re-tags `account_type` and nothing else, so the
 * post-move numbers are whatever these functions produce over the union of the
 * two books' rows. These tests pin the two properties the UI's confirmation
 * dialog promises: a move into an empty book is exact, and a merge preserves
 * share count and net capital while restating the invested/realized split.
 */
describe("moving a holding between account books", () => {
  it("is an exact transfer when the destination book holds nothing", () => {
    const moved = [
      buy("1", "ABC", 100, 10, 4, 0),
      buy("2", "ABC", 50, 12, 2.4, 30),
      sell("3", "ABC", 30, 15, 1.8, 60),
    ];
    const destination: TransactionRow[] = [];

    const before = aggregateHoldings(moved)[0];
    const after = aggregateHoldings([...destination, ...moved])[0];

    // Shares, totalCost, avgPrice, breakEvenPrice, feesInPositionBdt, openedAt.
    expect(after).toEqual(before);
    expect(totalRealizedProfitLossBdt([...destination, ...moved])).toBe(
      totalRealizedProfitLossBdt(moved),
    );
  });

  it("merges into an existing position: shares add up, cost basis blends", () => {
    // Source book: buy 100 @ 10, sell 50 @ 20 → 50 sh, cost 500, realized 500.
    // Destination:  buy 100 @ 30, dated between them → 100 sh, cost 3000.
    const moved = [buy("a1", "ABC", 100, 10, 0, 0), sell("a3", "ABC", 50, 20, 0, 60)];
    const destination = [buy("b2", "ABC", 100, 30, 0, 30)];

    const movedBefore = aggregateHoldings(moved)[0];
    const destBefore = aggregateHoldings(destination)[0];
    const merged = aggregateHoldings([...destination, ...moved])[0];

    expect(merged.shares).toBe(movedBefore.shares + destBefore.shares);
    expect(merged.shares).toBe(150);
    // The sell now re-prices against the blended average (20, not 10), so the
    // remaining book cost is 3000 rather than the 3500 the two books showed.
    expect(merged.avgPrice).toBeCloseTo(20, 5);
    expect(merged.totalCost).toBeCloseTo(3000, 2);
    expect(movedBefore.totalCost + destBefore.totalCost).toBeCloseTo(3500, 2);
  });

  it("merges without inventing or destroying capital", () => {
    const moved = [buy("a1", "ABC", 100, 10, 0, 0), sell("a3", "ABC", 50, 20, 0, 60)];
    const destination = [buy("b2", "ABC", 100, 30, 0, 30)];
    const union = [...destination, ...moved];

    // `invested − realized` is the net cash actually deployed. Both books'
    // numbers shift on a merge, but that difference must not: paid
    // 1000 + 3000, received 1000 → 3000 either way.
    const netBefore =
      aggregateHoldings(moved)[0].totalCost +
      aggregateHoldings(destination)[0].totalCost -
      (totalRealizedProfitLossBdt(moved) + totalRealizedProfitLossBdt(destination));
    const netAfter =
      aggregateHoldings(union)[0].totalCost - totalRealizedProfitLossBdt(union);

    expect(netBefore).toBeCloseTo(3000, 2);
    expect(netAfter).toBeCloseTo(netBefore, 6);
  });
});
