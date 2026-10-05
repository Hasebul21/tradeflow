# The data

**Everything in this folder is synthetic.** It is written by `scripts/seed.mjs` (the values come from `scripts/seed-data.mjs`). The trading codes are real Dhaka Stock Exchange symbols, but every price, trade, deposit, dividend, announcement, company figure, journal note and source file is made up. **All announcements are synthetic**: none was published by a company or the exchange, and no text names a real person.

The data covers 190 trading sessions (Sunday to Thursday; holidays are not modelled) ending on `SEED_END_DATE`, by default **Thursday 1 October 2026**, so it runs from 11 January to 1 October 2026. The seed is fixed: two runs with the same end date write identical files. Dates below are for the default end date.

Field names match Postgres columns, so `npm run db:load` loads the files without renaming (see the main README).

## Files

| File | Rows | Fields |
|---|---|---|
| `instruments.json` | 15 symbols in 7 sectors | `symbol, name, sector` |
| `bars.json` | 2,850 (15 x 190) | `symbol, bar_date, open, high, low, close, volume` |
| `transactions.json` | 45 trades | `id, created_at, symbol, side, quantity, price_per_share, category, fees_bdt, account_type` (`long_term` or `trade`) |
| `contributions.json` | 9 monthly deposits of Tk 70,000 | `id, created_at, amount_bdt, note` |
| `rules.json` | one document | `max_position_weight_pct` (25), `sector_tolerance_pct` (5), `sector_targets[]` (`sector, target_percent`), `trade_plans[]` (`id, created_at, symbol, side, target_price, quantity_shares, note, executed`), 10 plans |
| `announcements.json` | 66 | `id` (`a-001`...), `symbol, published_at` (11:00 or 15:00 Dhaka), `category` (`earnings`, `dividend_declaration`, `bonus_declaration`, `agm`, `price_sensitive`, `other`), `title, body, price_sensitive` |
| `corporate_actions.json` | 7: six cash dividends, one bonus issue | `id` (`ca-01`...), `symbol, kind` (`cash_dividend` or `stock_dividend`), `record_date, paid_on, cash_per_share_bdt, bonus_ratio` (0.1 = 10 bonus shares per 100), `announcement_id` |
| `index_bars.json` | 190 | `index` (`DSEX`), `bar_date, close` |
| `sector_index_bars.json` | 1,330 (7 x 190) | `sector, bar_date, close` |
| `fundamentals.json` | 45: 3 quarters per symbol | `symbol, period_end` (31 Dec 2025, 31 Mar and 30 Jun 2026), `reported_on` (the date of that quarter's earnings announcement), `eps_bdt, nav_per_share_bdt, revenue_mn_bdt, net_profit_mn_bdt` |
| `journal.json` | 30 | `id` (`j-001`...), `transaction_id, created_at` (two hours after the trade), `thesis, horizon` (`weeks`, `months`, `years`), `exit_condition, tags[]` |
| `profile.json` | one document | `display_name` ("Owner"), `base_currency` ("BDT"), `risk_tolerance, review_day` ("Thursday"), `investment_goal, excluded_sectors[], notes` |
| `sources/broker_statement.csv` | 45 | `broker_ref, trade_date, symbol, side, quantity, price, commission_bdt, settlement_date` (T+2 trading days) |
| `sources/bank_deposits.csv` | 10 | `bank_ref, value_date, amount_bdt, narration` (quoted, as it holds a comma) |

## How the numbers hang together

- Prices follow a factor model: each session DSEX moves, each sector index moves with DSEX plus its own noise, and each stock moves with its sector plus its own noise. So a stock's move can be compared with its sector index and with DSEX.
- Every cash dividend lowers the price on the ex-date (the session after the record date) by the dividend, and the bonus issue by the bonus ratio.
- Every dividend and bonus is for a symbol held on its record date, and has a declaration announcement (`announcement_id`) and an AGM notice.
- Every fundamentals row has a matching earnings announcement on `reported_on` with the same EPS. The title says whether profit was higher or lower than the same quarter last year.
- 30 of the 35 buys have a journal entry; the owner wrote none for the other five. Sells have none.

## The story the data tells

Thursdays are the owner's review days (`profile.review_day`). Each week below ends on a Thursday and spans five sessions, Sunday to Thursday.

| Week to | What happened | Files that show it | What a correct explanation must say |
|---|---|---|---|
| Thu 17 Sep | The bank sector rallies (bank index +5.4%) while DSEX is flat (-0.3%). BRACBANK +5.2%, EBL +6.2% and CITYBANK +5.9% all move with it. The portfolio gains 0.9% and beats DSEX by 1.2 points | `bars`, `sector_index_bars`, `index_bars` | The bank holdings rose in line with their sector, not for company reasons; the portfolio beat the market that week because of its bank weight |
| Thu 24 Sep | GP's record date for a Tk 12.50 cash dividend is Mon 21 Sep (declared 30 Aug, approved at the AGM on 10 Sep, record-date notice on 17 Sep). GP falls 4.8% in the week, by the dividend on the ex-date (Tue 22 Sep), while the telecom index rises 2.0%. The owner held 240 GP on the record date, so Tk 3,000 is due on 21 Oct | `corporate_actions` (`ca-07`), `announcements`, `bars`, `sector_index_bars` | The drop is the ex-dividend adjustment, not bad news; the dividend is owed and not yet paid |
| Thu 1 Oct | SQURPHARMA reports higher quarterly profit on Thu 24 Sep at 15:00 and rises 1.2% while the pharma index falls 3.0%. BXPHARMA reports lower quarterly profit (EPS Tk 1.62 against Tk 2.41 a year before, and Tk 2.05 the quarter before) at 11:00 on Sun 27 Sep, a price-sensitive announcement, and falls 14.9%: 11.9 points worse than its sector. SQURPHARMA goes from 24.7% of the portfolio on 24 Sep to 25.4% on 1 Oct, above the 25% limit. The portfolio falls 1.7% against DSEX's 0.7% and trails it by 0.9 points | `announcements`, `fundamentals`, `bars`, `sector_index_bars`, `rules` | BXPHARMA's fall is stock-specific and follows its results; SQURPHARMA newly breaks the position limit; the portfolio trailed the market because of BXPHARMA |
| 24 Sep and 1 Oct | Pharmaceuticals & Chemicals is 38.3% of the portfolio on 24 Sep and 37.8% on 1 Oct, against a 30% target and 5 points of tolerance | `rules`, `bars`, `transactions` | The sector rule is broken on both review days; a review on 1 Oct can say "still above target, as last week" |
| Apr to May | BRACBANK declares a 10% stock dividend (record date 28 Apr). The owner held 1,200 shares, so 120 bonus shares are credited on 19 May at zero cost. The average cost falls, total cost stays the same, and no cash moves | `corporate_actions` (`ca-04`), `announcements`, `transactions` (no bonus row; the app adds it) | Shares rose and average cost fell because of the bonus, not a purchase; there was no deposit or payment |

## Test cases planted in the data

They exist so later features can be tested against known answers. `src/test/story.data.test.ts` checks that each one is present.

**Thesis checks** (`journal.json` against the other files)

- Confirmed: the BATBC buys say "Buying BATBC for the dividend". BATBC paid Tk 18 a share on 12 Jul (`ca-05`).
- Contradicted: the first BXPHARMA buy (`t-015`) says "expecting earnings growth from new export markets". The quarters since show EPS falling: Tk 2.30, 2.05, then 1.62, and the price fell 14.9% in the last week.
- Undecided: the LHBL buy (`t-016`) says cement demand should pick up "after the monsoon", with the exit "Sell if it falls 15% below what I paid". Nothing in the data settles it yet. GP's "for the dividend" thesis is also only half settled: the dividend is owed but not paid by 1 Oct.
- The SQURPHARMA top-up (`t-038`) has the exit condition "Trim if it goes above 25% of the portfolio", which the data meets on 1 Oct.

**Pre-trade checks** (open trade plans in `rules.json`, run through the what-if preview at their target price)

- Would break a rule: `p-02`, buy 70 WALTONHIL. Engineering goes from 0% to above 10% against a 5% target.
- Would not: `p-03`, buy 300 EBL. Every rule that holds today still holds.

**Reconciliation** (`sources/` against the ledger). Exactly four differences; everything else matches exactly.

1. Commission mismatch: the EBL buy of 12 May (`t-021`, `BRK-20260512-021`): the broker charged Tk 45.68, the ledger has Tk 44.48 (Tk 1.20 more).
2. Broker trade missing from the ledger: a buy of 20 OLYMPIC on 2 Aug (`BRK-20260802-035`).
3. Ledger trade missing from the broker statement: the LHBL buy of 150 on 1 Jul (`t-030`).
4. Bank deposit missing from contributions: Tk 25,000 on 23 Jul (`BNK-0008`).

**Attribution**

- The portfolio beat DSEX in the week to 17 Sep (+1.2 points) and trailed it in the week to 1 Oct (-0.9 points).
- In the week to 1 Oct, BXPHARMA and SQURPHARMA are "stock-specific" and every other holding is "in line with sector".

There is no prompt-injection or other adversarial text in this data. Fixtures for that are kept apart and made later.
