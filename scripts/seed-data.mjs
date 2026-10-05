/**
 * Builds the whole synthetic data set as plain values. `scripts/seed.mjs`
 * writes it to data/; tests call `generate()` directly.
 *
 * Every number is made up. The trading codes are real Dhaka Stock Exchange
 * symbols so the pages read naturally, but prices, trades, deposits,
 * announcements and fundamentals come from a seeded random walk and the
 * tables below, never from a market, a broker or a bank.
 *
 * Prices follow a factor model: each session the market (DSEX) moves, each
 * sector moves with the market plus its own noise, and each stock moves with
 * its sector plus its own noise. The story weeks override those moves, and
 * dividends and bonus issues adjust the price on the ex-date, so the sector
 * indices, announcements and corporate actions all agree with the bars.
 *
 * Everything is placed by "sessions before the last bar" (ago), so the story
 * keeps its shape for any end date. The default end date is Thu 1 Oct 2026.
 */

export const DEFAULT_END_DATE = "2026-10-01";
export const SESSIONS = 190;
const COMMISSION_RATE = 0.004;
const DEPOSIT_BDT = 70_000;

// pe: price over yearly EPS, used to size the made-up EPS. sharesMn and margin size profit and revenue.
const UNIVERSE = [
  { symbol: "GP", name: "Grameenphone", sector: "Telecommunication", start: 300, pe: 13, sharesMn: 1350, margin: 0.3 },
  { symbol: "ROBI", name: "Robi Axiata", sector: "Telecommunication", start: 30, pe: 28, sharesMn: 5238, margin: 0.05 },
  { symbol: "BRACBANK", name: "BRAC Bank", sector: "Bank", start: 45, pe: 8, sharesMn: 1770, margin: 0.18 },
  { symbol: "EBL", name: "Eastern Bank", sector: "Bank", start: 30, pe: 7, sharesMn: 1240, margin: 0.2 },
  { symbol: "CITYBANK", name: "The City Bank", sector: "Bank", start: 22, pe: 6, sharesMn: 1330, margin: 0.17 },
  { symbol: "SQURPHARMA", name: "Square Pharmaceuticals", sector: "Pharmaceuticals & Chemicals", start: 210, pe: 10, sharesMn: 886, margin: 0.27 },
  { symbol: "BXPHARMA", name: "Beximco Pharmaceuticals", sector: "Pharmaceuticals & Chemicals", start: 150, pe: 17, sharesMn: 446, margin: 0.14 },
  { symbol: "RENATA", name: "Renata", sector: "Pharmaceuticals & Chemicals", start: 900, pe: 30, sharesMn: 114, margin: 0.13 },
  { symbol: "BATBC", name: "British American Tobacco Bangladesh", sector: "Food & Allied", start: 400, pe: 14, sharesMn: 540, margin: 0.11 },
  { symbol: "OLYMPIC", name: "Olympic Industries", sector: "Food & Allied", start: 170, pe: 18, sharesMn: 200, margin: 0.1 },
  { symbol: "LHBL", name: "LafargeHolcim Bangladesh", sector: "Cement", start: 60, pe: 12, sharesMn: 1161, margin: 0.16 },
  { symbol: "HEIDELBCEM", name: "Heidelberg Materials Bangladesh", sector: "Cement", start: 250, pe: 20, sharesMn: 56, margin: 0.06 },
  { symbol: "UPGDCL", name: "United Power Generation", sector: "Fuel & Power", start: 170, pe: 11, sharesMn: 580, margin: 0.3 },
  { symbol: "SUMITPOWER", name: "Summit Power", sector: "Fuel & Power", start: 25, pe: 9, sharesMn: 1068, margin: 0.12 },
  { symbol: "WALTONHIL", name: "Walton Hi-Tech Industries", sector: "Engineering", start: 1050, pe: 25, sharesMn: 303, margin: 0.09 },
];

const SECTOR_TARGETS = [
  { sector: "Bank", target_percent: 25 },
  { sector: "Pharmaceuticals & Chemicals", target_percent: 30 },
  { sector: "Telecommunication", target_percent: 15 },
  { sector: "Food & Allied", target_percent: 10 },
  { sector: "Cement", target_percent: 5 },
  { sector: "Fuel & Power", target_percent: 10 },
  { sector: "Engineering", target_percent: 5 },
];

// [sessions ago, symbol, side, shares, account]. "trade" is the short-term account.
const TRADES = [
  [185, "GP", "buy", 150, "long_term"],
  [182, "BRACBANK", "buy", 800, "long_term"],
  [178, "SQURPHARMA", "buy", 300, "long_term"],
  [175, "UPGDCL", "buy", 150, "long_term"],
  [170, "BATBC", "buy", 50, "long_term"],
  [166, "EBL", "buy", 600, "long_term"],
  [162, "RENATA", "buy", 20, "long_term"],
  [156, "HEIDELBCEM", "buy", 60, "trade"],
  [150, "OLYMPIC", "buy", 80, "long_term"],
  [146, "CITYBANK", "buy", 800, "long_term"],
  [142, "SQURPHARMA", "buy", 150, "long_term"],
  [138, "HEIDELBCEM", "sell", 60, "trade"],
  [134, "ROBI", "buy", 600, "trade"],
  [130, "GP", "buy", 60, "long_term"],
  [126, "BXPHARMA", "buy", 200, "long_term"],
  [122, "LHBL", "buy", 250, "long_term"],
  [118, "BRACBANK", "buy", 400, "long_term"],
  [114, "ROBI", "sell", 300, "trade"],
  [110, "SUMITPOWER", "buy", 900, "trade"],
  [106, "BATBC", "buy", 30, "long_term"],
  [102, "EBL", "buy", 400, "long_term"],
  [98, "UPGDCL", "buy", 100, "long_term"],
  [94, "RENATA", "buy", 16, "long_term"],
  [90, "SUMITPOWER", "sell", 300, "trade"],
  [86, "OLYMPIC", "buy", 50, "long_term"],
  [82, "SQURPHARMA", "buy", 150, "long_term"],
  [78, "GP", "sell", 40, "long_term"],
  [74, "CITYBANK", "buy", 500, "long_term"],
  [70, "HEIDELBCEM", "buy", 80, "trade"],
  [66, "LHBL", "buy", 150, "long_term"],
  [62, "HEIDELBCEM", "sell", 50, "trade"],
  [58, "BXPHARMA", "buy", 80, "long_term"],
  [54, "UPGDCL", "sell", 50, "long_term"],
  [50, "GP", "buy", 70, "long_term"],
  [46, "HEIDELBCEM", "sell", 30, "trade"],
  [42, "ROBI", "buy", 100, "trade"],
  [38, "BRACBANK", "buy", 200, "long_term"],
  [34, "SQURPHARMA", "buy", 55, "long_term"],
  [30, "EBL", "buy", 200, "long_term"],
  [26, "BXPHARMA", "buy", 40, "long_term"],
  [22, "WALTONHIL", "buy", 10, "trade"],
  [18, "WALTONHIL", "sell", 10, "trade"],
  [16, "OLYMPIC", "sell", 30, "long_term"],
  [13, "UPGDCL", "buy", 50, "long_term"],
  [6, "SUMITPOWER", "sell", 100, "trade"],
];

// Monthly deposits, as sessions ago.
const DEPOSITS = [188, 168, 147, 125, 104, 83, 62, 41, 20];

// Cash dividends and one bonus issue, each for a symbol held on the record date.
// The price drops on the next session (the ex-date) by the dividend, or by the bonus ratio.
const ACTIONS = [
  { key: "upg", symbol: "UPGDCL", kind: "cash_dividend", declaredAgo: 172, recordAgo: 160, payDays: 25, cash: 4, bonus: null, agmAgo: 165 },
  { key: "sqr", symbol: "SQURPHARMA", kind: "cash_dividend", declaredAgo: 145, recordAgo: 130, payDays: 26, cash: 6, bonus: null, agmAgo: 136 },
  { key: "ebl", symbol: "EBL", kind: "cash_dividend", declaredAgo: 132, recordAgo: 120, payDays: 24, cash: 1.5, bonus: null, agmAgo: 125 },
  { key: "brac", symbol: "BRACBANK", kind: "stock_dividend", declaredAgo: 127, recordAgo: 112, payDays: 21, cash: null, bonus: 0.1, agmAgo: 116 },
  { key: "bat", symbol: "BATBC", kind: "cash_dividend", declaredAgo: 88, recordAgo: 75, payDays: 24, cash: 18, bonus: null, agmAgo: 80 },
  { key: "oly", symbol: "OLYMPIC", kind: "cash_dividend", declaredAgo: 72, recordAgo: 60, payDays: 25, cash: 5, bonus: null, agmAgo: 64 },
  { key: "gp", symbol: "GP", kind: "cash_dividend", declaredAgo: 24, recordAgo: 8, payDays: 30, cash: 12.5, bonus: null, agmAgo: 15 },
];

// Quarters reported in the window. Each has one earnings announcement and one fundamentals row.
const QUARTERS = [
  { period_end: "2025-12-31", firstAgo: 165 },
  { period_end: "2026-03-31", firstAgo: 112 },
  { period_end: "2026-06-30", firstAgo: 58 },
];

// EPS for the planted results: [this quarter, same quarter last year], per quarter above.
const PLANTED_EPS = {
  BXPHARMA: [[2.3, 2.1], [2.05, 2.2], [1.62, 2.41]],
  SQURPHARMA: [[4.9, 4.6], [5.2, 4.8], [5.84, 4.97]],
};

// Theses: the first buy of each symbol uses its line; later buys use the "adding" line.
const THESES = {
  GP: ["Buying GP for the dividend. It pays out most of its profit and the cash flow is steady.", "Adding to GP before the dividend record date.", "years", ["dividend", "defensive"]],
  ROBI: ["A short trade on Robi: the share has fallen a long way and data revenue is growing.", "Adding to the Robi trade after a quiet month.", "weeks", ["trade", "telecom"]],
  BRACBANK: ["BRACBANK is the best-run private bank I follow, and the share is cheap against its book value.", "Adding to BRACBANK; the bank is still cheap against its book value.", "years", ["bank", "value"]],
  EBL: ["A cheap second bank, to spread the bank exposure beyond BRACBANK.", "Adding to EBL at a low price against book value.", "months", ["bank", "value"]],
  CITYBANK: ["City Bank trades below its book value and pays a steady dividend.", "Adding to City Bank while it stays below book value.", "months", ["bank", "value"]],
  SQURPHARMA: ["Square is the steadiest pharma company on the exchange. A core holding to keep adding to.", "Adding to Square, still my highest-conviction holding.", "years", ["pharma", "core"]],
  BXPHARMA: ["Buying BXPHARMA expecting earnings growth from new export markets this year.", "Averaging down on BXPHARMA. The export story has not changed.", "months", ["pharma", "growth"]],
  RENATA: ["A small position in Renata. It is expensive, but profit grows every year.", "Adding a little more Renata after a dip.", "years", ["pharma", "growth"]],
  BATBC: ["Buying BATBC for the dividend. It pays a large cash dividend every year.", "Adding to BATBC for the dividend income.", "years", ["dividend"]],
  OLYMPIC: ["Olympic sells biscuits everywhere in the country; demand holds up in a slow economy.", "Adding to Olympic on a small dip.", "years", ["defensive"]],
  LHBL: ["Cement demand should pick up when building projects restart after the monsoon.", "Adding to LHBL before the building season.", "months", ["cyclical"]],
  HEIDELBCEM: ["A short trade on Heidelberg: it has fallen for weeks and looks oversold.", "Another short trade on Heidelberg after a fall.", "weeks", ["trade", "cyclical"]],
  UPGDCL: ["Power plants with fixed government contracts should hold up if the market falls.", "Adding to United Power for its steady income.", "months", ["defensive", "power"]],
  SUMITPOWER: ["A trade on Summit Power: the share is near its yearly low.", "Adding to the Summit Power trade.", "weeks", ["trade", "power"]],
  WALTONHIL: ["A small trade on Walton ahead of the festival sales season.", "Adding to the Walton trade.", "weeks", ["trade"]],
};

// Exit conditions by trade (sessions ago). The rest have none.
const EXITS = {
  185: "Sell if the dividend is cut.",
  126: "Sell if two quarters in a row show lower profit.",
  122: "Sell if it falls 15% below what I paid.",
  34: "Trim if it goes above 25% of the portfolio.",
  110: "Sell if it gains 10%.",
  134: "Sell half if it gains 15%.",
};
// Buys without a journal entry: the owner did not always write one.
const UNJOURNALLED = new Set([142, 98, 86, 70, 42]);

// [symbol, sessions ago, category, title, body, price-sensitive]
const NOTICES = [
  ["EBL", 150, "other", "Credit rating surveillance completed", "The credit rating agency kept the bank's long-term and short-term ratings unchanged after its annual surveillance.", false],
  ["LHBL", 140, "other", "Reply to an exchange query on recent price movement", "The company states that it has no undisclosed price-sensitive information behind the recent unusual movement in its share price.", false],
  ["WALTONHIL", 100, "price_sensitive", "Board approves a new compressor production line", "The board approved an investment of Tk 1,200 million in a new compressor production line, to be funded from retained earnings.", true],
  ["UPGDCL", 92, "other", "Change of corporate office address", "The company has moved its corporate office. Shareholder services are unchanged.", false],
  ["CITYBANK", 70, "other", "Credit rating surveillance completed", "The credit rating agency kept the bank's ratings unchanged after its annual surveillance.", false],
  ["HEIDELBCEM", 44, "price_sensitive", "Plant shut for annual maintenance", "One kiln will be shut for three weeks of planned maintenance. Sales will be met from stock.", true],
  ["GP", 10, "other", "Record date for the cash dividend", "", false],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tick = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n, w) => String(n).padStart(w, "0");
const atDhaka = (ymd, hour) => new Date(`${ymd}T${pad(hour, 2)}:00:00+06:00`).toISOString();
const dhakaYmd = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });

export function addCalendarDays(ymd, n) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The date `n` DSE sessions (Sun-Thu) after `ymd`, not counting `ymd` itself. */
export function addTradingDays(ymd, n) {
  let t = Date.parse(`${ymd}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    t += 86_400_000;
    if (new Date(t).getUTCDay() <= 4) left -= 1;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** The last `n` Sun-Thu days ending on or before `endYmd`, oldest first. Holidays are not modelled. */
export function tradingDays(endYmd, n) {
  let t = Date.parse(`${endYmd}T00:00:00Z`);
  const out = [];
  while (out.length < n) {
    if (new Date(t).getUTCDay() <= 4) out.push(new Date(t).toISOString().slice(0, 10));
    t -= 86_400_000;
  }
  return out.reverse();
}

/** `21 Sep 2026`. */
function longDate(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/**
 * Daily returns for the market, each sector and each stock. `ago` counts
 * sessions back from the last bar. The planted weeks:
 *  - ago 14-10 (week to Thu 17 Sep by default): banks rally as a sector, DSEX quiet;
 *  - ago 4-0 (week to Thu 1 Oct): the pharma sector dips about 3%, BXPHARMA
 *    falls far more, and SQURPHARMA rises after its results.
 * GP's ex-dividend drop (ago 7) comes from its corporate action.
 */
function storyReturns(rand, n) {
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const sectors = [...new Set(UNIVERSE.map((u) => u.sector))];
  const market = [];
  const sector = new Map(sectors.map((s) => [s, []]));
  const stock = new Map(UNIVERSE.map((u) => [u.symbol, []]));
  for (let t = 0; t < n; t++) {
    const ago = n - 1 - t;
    const bankWeek = ago >= 10 && ago <= 14;
    const lastWeek = ago <= 4;
    const m = bankWeek ? gauss() * 0.0015 : lastWeek ? -0.001 + gauss() * 0.001 : gauss() * 0.006 + 0.0003;
    market.push(m);
    for (const s of sectors) {
      let f = m + gauss() * (bankWeek || lastWeek ? 0.0015 : 0.004);
      if (bankWeek && s === "Bank") f = m + 0.011 + gauss() * 0.001;
      if (lastWeek && s === "Pharmaceuticals & Chemicals") f = m - 0.005 + gauss() * 0.0008;
      sector.get(s).push(f);
    }
    for (const u of UNIVERSE) {
      let idio = gauss() * (bankWeek || lastWeek ? 0.002 : 0.008);
      if (lastWeek && u.symbol === "BXPHARMA") idio = -0.025 + gauss() * 0.002;
      if (lastWeek && u.symbol === "SQURPHARMA") idio = 0.009 + gauss() * 0.001;
      stock.get(u.symbol).push(sector.get(u.sector)[t] + idio);
    }
  }
  return { market, sector, stock };
}

function makeBars(days, returns, exAdjust, rand) {
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const bars = [];
  for (const u of UNIVERSE) {
    let prev = u.start;
    days.forEach((date, t) => {
      const adjust = exAdjust.get(`${u.symbol}:${date}`);
      const base = prev * (1 + returns.stock.get(u.symbol)[t]);
      const close = tick(Math.max(1, adjust ? adjust(prev, base) : base));
      const open = tick(Math.max(1, (adjust ? close : prev) * (1 + gauss() * 0.003)));
      const spread = Math.abs(gauss()) * 0.005;
      bars.push({
        symbol: u.symbol,
        bar_date: date,
        open,
        high: tick(Math.max(open, close) * (1 + spread)),
        low: tick(Math.min(open, close) * (1 - spread)),
        close,
        volume: Math.round(50_000 + rand() * 450_000),
      });
      prev = close;
    });
  }
  return bars;
}

function indexSeries(days, rets, start) {
  let close = start;
  return days.map((bar_date, t) => {
    close = round2(close * (1 + rets[t]));
    return { bar_date, close };
  });
}

export function generate(endDate = DEFAULT_END_DATE) {
  const rand = mulberry32(20261005);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const days = tradingDays(endDate, SESSIONS);
  const day = (ago) => days[days.length - 1 - ago];
  const info = new Map(UNIVERSE.map((u) => [u.symbol, u]));

  // Ex-date price adjustments, applied to the close of the session after the record date.
  const exAdjust = new Map();
  for (const a of ACTIONS) {
    const key = `${a.symbol}:${day(a.recordAgo - 1)}`;
    exAdjust.set(key, a.kind === "cash_dividend" ? (prev, base) => base - a.cash : (prev, base) => base / (1 + a.bonus));
  }

  const returns = storyReturns(rand, days.length);
  const bars = makeBars(days, returns, exAdjust, rand);
  const closeOn = (symbol, ago) => bars.find((b) => b.symbol === symbol && b.bar_date === day(ago)).close;
  const lastClose = (symbol) => closeOn(symbol, 0);

  const index_bars = indexSeries(days, returns.market, 5300).map((b) => ({ index: "DSEX", ...b }));
  const sector_index_bars = [...returns.sector].flatMap(([sector, rets]) =>
    indexSeries(days, rets, 1000).map((b) => ({ sector, ...b })),
  );

  const transactions = TRADES.map(([ago, symbol, side, quantity, account_type], i) => {
    const price = tick(closeOn(symbol, ago) * (1 + gauss() * 0.003));
    return {
      id: `t-${pad(i + 1, 3)}`,
      created_at: atDhaka(day(ago), 11),
      symbol,
      side,
      quantity,
      price_per_share: price,
      category: null,
      fees_bdt: round2(quantity * price * COMMISSION_RATE),
      account_type,
    };
  });
  const tradeAt = new Map(TRADES.map(([ago], i) => [ago, transactions[i]]));

  const contributions = DEPOSITS.map((ago, i) => ({
    id: `c-${pad(i + 1, 2)}`,
    created_at: atDhaka(day(ago), 11),
    amount_bdt: DEPOSIT_BDT,
    note: "Monthly deposit",
  }));

  const plan = (i, ago, symbol, side, target, qty, note, executed = false) => ({
    id: `p-${pad(i, 2)}`,
    created_at: atDhaka(day(ago), 20),
    symbol,
    side,
    target_price: tick(target),
    quantity_shares: qty,
    note,
    executed,
  });
  const rules = {
    max_position_weight_pct: 25,
    sector_tolerance_pct: 5,
    sector_targets: SECTOR_TARGETS,
    trade_plans: [
      plan(1, 40, "BXPHARMA", "buy", closeOn("BXPHARMA", 26) * 1.01, 40, "Average down once more", true),
      plan(2, 30, "WALTONHIL", "buy", lastClose("WALTONHIL") * 0.97, 70, "First long-term lot in Walton if it dips"),
      plan(3, 25, "EBL", "buy", lastClose("EBL") * 0.98, 300, "Add to the cheaper bank"),
      plan(4, 20, "SQURPHARMA", "sell", lastClose("SQURPHARMA") * 1.05, 100, "Trim the overweight position"),
      plan(5, 20, "BATBC", "sell", lastClose("BATBC") * 1.08, 30, "Take some profit"),
      plan(6, 15, "GP", "buy", closeOn("GP", 9) * 0.96, 50, "Add on a dip of 4% or more"),
      plan(7, 12, "BXPHARMA", "buy", lastClose("BXPHARMA") * 0.9, 100, "Average down only after the next results"),
      plan(8, 10, "LHBL", "sell", lastClose("LHBL") * 1.15, 400, "Sell if the cement thesis plays out"),
      plan(9, 8, "RENATA", "buy", lastClose("RENATA") * 0.95, 5, "Add a little on weakness"),
      plan(10, 5, "SUMITPOWER", "sell", lastClose("SUMITPOWER") * 1.06, 500, "Close the trade at a 6% gain"),
    ],
  };

  const announcements = makeAnnouncements({ day, rand, info });
  const idFor = new Map(announcements.filter((a) => a.key).map((a) => [a.key, a.id]));
  const corporate_actions = [...ACTIONS]
    .sort((a, b) => b.recordAgo - a.recordAgo)
    .map((a, i) => ({
      id: `ca-${pad(i + 1, 2)}`,
      symbol: a.symbol,
      kind: a.kind,
      record_date: day(a.recordAgo),
      paid_on: addCalendarDays(day(a.recordAgo), a.payDays),
      cash_per_share_bdt: a.cash,
      bonus_ratio: a.bonus,
      announcement_id: idFor.get(`decl:${a.key}`),
    }));

  const fundamentals = announcements
    .filter((a) => a.quarter)
    .map((a) => {
      const u = info.get(a.symbol);
      const netProfit = round2(a.eps * u.sharesMn);
      return {
        symbol: a.symbol,
        period_end: a.quarter,
        reported_on: dhakaYmd(a.published_at),
        eps_bdt: a.eps,
        nav_per_share_bdt: round2(u.start / (u.pe / 8) + a.qIndex * 0.6),
        revenue_mn_bdt: round2(netProfit / u.margin),
        net_profit_mn_bdt: netProfit,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.period_end.localeCompare(b.period_end));

  const journal = makeJournal(tradeAt);

  const instruments = UNIVERSE.map(({ symbol, name, sector }) => ({ symbol, name, sector }));
  // Only the published fields; the rest were working values for the other files.
  const cleanAnnouncements = announcements.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    published_at: a.published_at,
    category: a.category,
    title: a.title,
    body: a.body,
    price_sensitive: a.price_sensitive,
  }));

  return {
    days,
    json: {
      instruments,
      bars,
      transactions,
      contributions,
      rules,
      announcements: cleanAnnouncements,
      corporate_actions,
      index_bars,
      sector_index_bars,
      fundamentals,
      journal,
      profile: {
        display_name: "Owner",
        base_currency: "BDT",
        risk_tolerance: "medium",
        review_day: "Thursday",
        investment_goal: "Grow long-term savings through steady dividend-paying DSE companies, without chasing short-term moves.",
        excluded_sectors: [],
        notes: null,
      },
    },
    csv: {
      broker_statement: toCsv(
        ["broker_ref", "trade_date", "symbol", "side", "quantity", "price", "commission_bdt", "settlement_date"],
        makeBrokerStatement(transactions, day, closeOn),
      ),
      bank_deposits: toCsv(["bank_ref", "value_date", "amount_bdt", "narration"], makeBankDeposits(contributions, day)),
    },
  };
}

function earningsText(eps, lastYear) {
  const higher = eps >= lastYear;
  return {
    title: `Quarterly results: profit ${higher ? "higher" : "lower"} than the same quarter last year`,
    body: `Earnings per share for the quarter were Tk ${eps.toFixed(2)}, against Tk ${lastYear.toFixed(2)} for the same quarter last year.`,
  };
}

function makeAnnouncements({ day, rand, info }) {
  const rows = [];
  const hour = () => (rand() < 0.5 ? 11 : 15);

  for (const u of info.values()) {
    const quarterEps = (u.start / u.pe) / 4;
    QUARTERS.forEach((q, qIndex) => {
      const planted = PLANTED_EPS[u.symbol]?.[qIndex];
      const eps = planted ? planted[0] : round2(quarterEps * (0.9 + rand() * 0.2));
      const lastYear = planted ? planted[1] : round2(eps * (0.85 + rand() * 0.3));
      const text = earningsText(eps, lastYear);
      let ago = q.firstAgo - Math.floor(rand() * 12);
      let at = hour();
      // The planted results: SQURPHARMA after the close on Thu 24 Sep, BXPHARMA at 11:00 on Sun 27 Sep.
      if (qIndex === 2 && u.symbol === "SQURPHARMA") [ago, at] = [5, 15];
      if (qIndex === 2 && u.symbol === "BXPHARMA") [ago, at] = [4, 11];
      if (qIndex === 2 && u.symbol === "SQURPHARMA") text.body += " Export sales grew faster than local sales.";
      if (qIndex === 2 && u.symbol === "BXPHARMA") text.body += " The company cited higher raw material and finance costs.";
      rows.push({ symbol: u.symbol, published_at: atDhaka(day(ago), at), category: "earnings", ...text, price_sensitive: true, quarter: q.period_end, qIndex, eps });
    });
  }

  for (const a of ACTIONS) {
    const record = longDate(day(a.recordAgo));
    const pct = a.kind === "cash_dividend" ? Math.round(a.cash * 10) : Math.round(a.bonus * 100);
    rows.push(
      a.kind === "cash_dividend"
        ? {
            key: `decl:${a.key}`,
            symbol: a.symbol,
            published_at: atDhaka(day(a.declaredAgo), 15),
            category: "dividend_declaration",
            title: `Cash dividend of Tk ${a.cash.toFixed(2)} per share declared`,
            body: `The board has recommended a cash dividend of ${pct}% (Tk ${a.cash.toFixed(2)} per share). The record date is ${record}.`,
            price_sensitive: true,
          }
        : {
            key: `decl:${a.key}`,
            symbol: a.symbol,
            published_at: atDhaka(day(a.declaredAgo), 15),
            category: "bonus_declaration",
            title: `${pct}% stock dividend (bonus shares) declared`,
            body: `The board has recommended a ${pct}% stock dividend: ${pct} bonus shares for every 100 held. The record date is ${record}.`,
            price_sensitive: true,
          },
      {
        symbol: a.symbol,
        published_at: atDhaka(day(a.agmAgo), 11),
        category: "agm",
        title: "Annual general meeting approves the dividend",
        body: `Shareholders approved the ${a.kind === "cash_dividend" ? "cash" : "stock"} dividend at the annual general meeting, held on a digital platform.`,
        price_sensitive: false,
      },
    );
  }

  const gp = ACTIONS.find((a) => a.key === "gp");
  for (const [symbol, ago, category, title, body, ps] of NOTICES) {
    const text =
      body ||
      `Shareholders on the register on the record date, ${longDate(day(gp.recordAgo))}, will receive the cash dividend. The shares trade ex-dividend from the next session.`;
    rows.push({ symbol, published_at: atDhaka(day(ago), 15), category, title, body: text, price_sensitive: ps });
  }

  return rows
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.symbol.localeCompare(b.symbol) || a.category.localeCompare(b.category))
    .map((r, i) => ({ id: `a-${pad(i + 1, 3)}`, ...r }));
}

/** Two hours after each buy, on the same Dhaka day. */
function makeJournal(tradeAt) {
  const seen = new Set();
  const rows = [];
  for (const [ago, t] of [...tradeAt].sort((a, b) => b[0] - a[0])) {
    if (t.side !== "buy") continue;
    const [first, again, horizon, tags] = THESES[t.symbol];
    const thesis = seen.has(t.symbol) ? again : first;
    seen.add(t.symbol);
    if (UNJOURNALLED.has(ago)) continue;
    rows.push({
      transaction_id: t.id,
      created_at: new Date(Date.parse(t.created_at) + 2 * 3_600_000).toISOString(),
      thesis,
      horizon,
      exit_condition: EXITS[ago] ?? null,
      tags,
    });
  }
  return rows.map((r, i) => ({ id: `j-${pad(i + 1, 3)}`, ...r }));
}

/**
 * The broker's copy of every trade, with three planted differences: the
 * commission on the 21st trade (an EBL buy) is Tk 1.20 higher, the 30th
 * trade (an LHBL buy) is missing, and an OLYMPIC buy appears that the ledger
 * never recorded.
 */
function makeBrokerStatement(transactions, day, closeOn) {
  const rows = transactions
    .filter((t) => t.id !== "t-030")
    .map((t) => ({
      trade_date: dhakaYmd(t.created_at),
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: t.price_per_share,
      commission_bdt: t.id === "t-021" ? round2(t.fees_bdt + 1.2) : t.fees_bdt,
    }));
  const extraPrice = closeOn("OLYMPIC", 44);
  rows.push({ trade_date: day(44), symbol: "OLYMPIC", side: "buy", quantity: 20, price: extraPrice, commission_bdt: round2(20 * extraPrice * COMMISSION_RATE) });
  rows.sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.symbol.localeCompare(b.symbol));
  return rows.map((r, i) => ({
    broker_ref: `BRK-${r.trade_date.replace(/-/g, "")}-${pad(i + 1, 3)}`,
    ...r,
    settlement_date: addTradingDays(r.trade_date, 2),
  }));
}

/** One bank row per deposit, plus a planted Tk 25,000 transfer with no contribution. */
function makeBankDeposits(contributions, day) {
  const rows = contributions.map((c) => ({ value_date: dhakaYmd(c.created_at), amount_bdt: c.amount_bdt }));
  rows.push({ value_date: day(50), amount_bdt: 25_000 });
  rows.sort((a, b) => a.value_date.localeCompare(b.value_date));
  return rows.map((r, i) => ({ bank_ref: `BNK-${pad(i + 1, 4)}`, ...r, narration: "Fund transfer to brokerage account, BO linked" }));
}
