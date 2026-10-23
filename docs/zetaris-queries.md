# Zetaris queries

Written by `npm run parity` on 2026-10-23. Each statement is what `sql()` in `src/agent/queries.ts` returns for the params shown, over the datasources `tradeflow_ledger` and `tradeflow_external`.
Parity compares only the columns each statement selects; `local()` adds the rest (the PORTFOLIO row, the labels, weights and text bodies).

## week_moves

Params: `{"as_of":"2026-10-01","sessions":5}`

Columns: `symbol`, `from_close`, `to_close`, `change_pct`

```sql
SELECT symbol, from_close, to_close, ROUND((to_close - from_close) / from_close * 100, 2) AS change_pct
FROM (
  SELECT symbol,
         MAX(CASE WHEN rn = 1 THEN close END) AS to_close,
         MAX(CASE WHEN rn = 6 THEN close END) AS from_close
  FROM (
    SELECT symbol, close, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY bar_date DESC) AS rn
    FROM tradeflow_ledger.bars
    WHERE bar_date <= CAST('2026-10-01' AS DATE)
      AND symbol IN (
        SELECT symbol FROM tradeflow_ledger.transactions
        WHERE created_at < CAST('2026-10-02T00:00:00+06:00' AS TIMESTAMP)
        GROUP BY symbol
        HAVING SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END) > 0
      )
  ) ranked
  WHERE rn IN (1, 6)
  GROUP BY symbol
) w
WHERE from_close IS NOT NULL AND to_close IS NOT NULL
ORDER BY symbol
```

parity: match

## sector_vs_stock

Params: `{"as_of":"2026-10-01","sessions":5}`

Columns: `sector`, `close`, `change_pct`

```sql
SELECT sector, close, ROUND((close - from_close) / from_close * 100, 2) AS change_pct
FROM (
  SELECT sector,
         MAX(CASE WHEN rn = 1 THEN close END) AS close,
         MAX(CASE WHEN rn = 6 THEN close END) AS from_close
  FROM (
    SELECT sector, close, ROW_NUMBER() OVER (PARTITION BY sector ORDER BY bar_date DESC) AS rn
    FROM tradeflow_ledger.sector_index_bars
    WHERE bar_date <= CAST('2026-10-01' AS DATE)
  ) ranked
  WHERE rn IN (1, 6)
  GROUP BY sector
) w
WHERE from_close IS NOT NULL AND close IS NOT NULL
ORDER BY change_pct, sector
```

parity: match

## announcements_between

Params: `{"from":"2026-09-24","to":"2026-10-01"}`

Columns: `id`, `symbol`, `published_on`, `category`, `price_sensitive`, `title`

```sql
SELECT id, symbol, date_format(from_utc_timestamp(to_utc_timestamp(published_at, current_timezone()), 'Asia/Dhaka'), 'yyyy-MM-dd') AS published_on, category, price_sensitive, title
FROM tradeflow_external.announcements
WHERE published_at >= CAST('2026-09-24T00:00:00+06:00' AS TIMESTAMP)
  AND published_at < CAST('2026-10-02T00:00:00+06:00' AS TIMESTAMP)
ORDER BY published_at DESC, id DESC
```

parity: match

## fundamentals_latest

Params: `{"symbol":"BXPHARMA","as_of":"2026-10-01"}`

Columns: `symbol`, `period_end`, `reported_on`, `eps_bdt`, `nav_per_share_bdt`, `revenue_mn_bdt`, `net_profit_mn_bdt`

```sql
SELECT symbol, period_end, reported_on, eps_bdt, nav_per_share_bdt, revenue_mn_bdt, net_profit_mn_bdt
FROM tradeflow_external.fundamentals
WHERE symbol = 'BXPHARMA'
  AND reported_on <= CAST('2026-10-01' AS DATE)
ORDER BY period_end
```

parity: match

## dividends_between

Params: `{"from":"2026-01-01","to":"2026-10-01"}`

Columns: `action_id`, `kind`, `symbol`, `record_date`, `paid_on`, `shares`, `cash_per_share_bdt`, `amount_bdt`, `bonus_shares`, `paid`

```sql
WITH acts AS (
  SELECT id, kind, UPPER(TRIM(symbol)) AS symbol, record_date, paid_on,
         CAST(cash_per_share_bdt AS DOUBLE) AS cash, CAST(bonus_ratio AS DOUBLE) AS ratio
  FROM tradeflow_ledger.corporate_actions
),
held AS (
  SELECT a.id, COALESCE(SUM(CASE WHEN t.side = 'buy' THEN CAST(t.quantity AS DOUBLE) ELSE -CAST(t.quantity AS DOUBLE) END), 0) AS ledger_shares
  FROM acts a
  LEFT JOIN tradeflow_ledger.transactions t ON UPPER(TRIM(t.symbol)) = a.symbol AND to_date(from_utc_timestamp(to_utc_timestamp(t.created_at, current_timezone()), 'Asia/Dhaka')) <= a.record_date
  GROUP BY a.id
),
bonus AS (
  SELECT a.symbol, a.paid_on, FLOOR(h.ledger_shares * a.ratio + 1e-9) AS bonus_shares
  FROM acts a JOIN held h ON h.id = a.id
  WHERE a.kind = 'stock_dividend' AND a.paid_on <= CAST('2026-10-01' AS DATE)
),
ent AS (
  SELECT a.id, a.kind, a.symbol, a.record_date, a.paid_on, a.cash, a.ratio,
         MAX(h.ledger_shares) + COALESCE(SUM(b.bonus_shares), 0) AS shares
  FROM acts a
  JOIN held h ON h.id = a.id
  LEFT JOIN bonus b ON b.symbol = a.symbol AND b.paid_on <= a.record_date
  WHERE a.record_date >= CAST('2026-01-01' AS DATE) AND a.record_date <= CAST('2026-10-01' AS DATE)
  GROUP BY a.id, a.kind, a.symbol, a.record_date, a.paid_on, a.cash, a.ratio
)
SELECT id AS action_id, kind, symbol, date_format(record_date, 'yyyy-MM-dd') AS record_date, date_format(paid_on, 'yyyy-MM-dd') AS paid_on, shares,
       CASE WHEN kind = 'cash_dividend' THEN COALESCE(cash, 0) END AS cash_per_share_bdt,
       CASE WHEN kind = 'cash_dividend' THEN ROUND(shares * COALESCE(cash, 0), 2) ELSE 0 END AS amount_bdt,
       CASE WHEN kind = 'stock_dividend' THEN FLOOR(shares * ratio + 1e-9) ELSE 0 END AS bonus_shares,
       paid_on <= CAST('2026-10-01' AS DATE) AS paid
FROM ent
WHERE (kind = 'cash_dividend' AND shares > 0)
   OR (kind = 'stock_dividend' AND paid_on <= CAST('2026-10-01' AS DATE) AND FLOOR(shares * ratio + 1e-9) > 0)
ORDER BY record_date, action_id
```

parity: match

## journal_for_symbol

Params: `{"as_of":"2026-10-01"}`

Columns: `id`, `transaction_id`, `symbol`, `side`, `trade_date`, `quantity`, `price_per_share`, `horizon`, `thesis`, `exit_condition`

```sql
SELECT j.id, j.transaction_id, t.symbol, t.side, date_format(from_utc_timestamp(to_utc_timestamp(t.created_at, current_timezone()), 'Asia/Dhaka'), 'yyyy-MM-dd') AS trade_date, t.quantity, t.price_per_share,
       j.horizon, j.thesis, j.exit_condition
FROM tradeflow_ledger.journal j
JOIN tradeflow_ledger.transactions t ON t.id = j.transaction_id
WHERE j.created_at < CAST('2026-10-02T00:00:00+06:00' AS TIMESTAMP)
  AND t.created_at < CAST('2026-10-02T00:00:00+06:00' AS TIMESTAMP)
ORDER BY j.created_at DESC, j.id DESC
```

parity: match

## rule_findings

Params: `{"as_of":"2026-10-01"}`

Columns: `row_type`, `symbol`, `sector`, `shares`, `market_value_bdt`, `weight_pct`, `target_pct`, `delta_pct`

```sql
WITH ledger AS (
  SELECT UPPER(TRIM(t.symbol)) AS symbol, CASE WHEN t.side = 'buy' THEN CAST(t.quantity AS DOUBLE) ELSE -CAST(t.quantity AS DOUBLE) END AS q
  FROM tradeflow_ledger.transactions t
  WHERE t.created_at < CAST('2026-10-02T00:00:00+06:00' AS TIMESTAMP)
  UNION ALL
  SELECT UPPER(TRIM(a.symbol)) AS symbol, FLOOR(SUM(CASE WHEN t.side = 'buy' THEN CAST(t.quantity AS DOUBLE) ELSE -CAST(t.quantity AS DOUBLE) END) * CAST(a.bonus_ratio AS DOUBLE) + 1e-9) AS q
    FROM tradeflow_ledger.corporate_actions a
    JOIN tradeflow_ledger.transactions t ON UPPER(TRIM(t.symbol)) = UPPER(TRIM(a.symbol)) AND to_date(from_utc_timestamp(to_utc_timestamp(t.created_at, current_timezone()), 'Asia/Dhaka')) <= a.record_date
    WHERE a.kind = 'stock_dividend' AND a.record_date <= CAST('2026-10-01' AS DATE) AND a.paid_on <= CAST('2026-10-01' AS DATE)
    GROUP BY a.id, a.symbol, a.bonus_ratio
),
held AS (
  SELECT symbol, SUM(q) AS shares FROM ledger GROUP BY symbol HAVING SUM(q) > 0
),
last_close AS (
  SELECT symbol, close FROM (
    SELECT UPPER(TRIM(symbol)) AS symbol, CAST(close AS DOUBLE) AS close,
           ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(symbol)) ORDER BY bar_date DESC) AS rn
    FROM tradeflow_ledger.bars
    WHERE bar_date <= CAST('2026-10-01' AS DATE)
  ) ranked
  WHERE rn = 1
),
pos AS (
  SELECT h.symbol, i.sector, COALESCE(NULLIF(TRIM(i.sector), ''), 'Unknown') AS sector_key, h.shares, ROUND(c.close * h.shares, 2) AS mv
  FROM held h
  JOIN last_close c ON c.symbol = h.symbol
  LEFT JOIN tradeflow_ledger.instruments i ON UPPER(TRIM(i.symbol)) = h.symbol
),
total AS (
  SELECT SUM(mv) AS tmv FROM pos WHERE mv > 0
),
sec AS (
  SELECT p.sector_key AS sector, SUM(p.mv) / MAX(t.tmv) * 100 AS pct
  FROM pos p CROSS JOIN total t
  WHERE p.mv > 0
  GROUP BY p.sector_key
),
tgt AS (
  SELECT TRIM(sector) AS sector, CAST(target_percent AS DOUBLE) AS target_pct FROM tradeflow_ledger.sector_targets
)
SELECT 'position' AS row_type, p.symbol, p.sector, p.shares, p.mv AS market_value_bdt, ROUND(p.mv / t.tmv * 100, 2) AS weight_pct,
       CAST(NULL AS DOUBLE) AS target_pct, CAST(NULL AS DOUBLE) AS delta_pct
FROM pos p CROSS JOIN total t
UNION ALL
SELECT 'sector' AS row_type, CAST(NULL AS STRING) AS symbol, COALESCE(s.sector, g.sector) AS sector, CAST(NULL AS DOUBLE) AS shares,
       CAST(NULL AS DOUBLE) AS market_value_bdt, ROUND(COALESCE(s.pct, 0), 2) AS weight_pct, g.target_pct,
       CASE WHEN g.sector IS NULL THEN CAST(NULL AS DOUBLE) ELSE ROUND(COALESCE(s.pct, 0) - g.target_pct, 2) END AS delta_pct
FROM sec s FULL OUTER JOIN tgt g ON LOWER(s.sector) = LOWER(g.sector)
ORDER BY row_type, weight_pct DESC
```

parity: match

## reconciliation

Params: `{}`

Columns: `issue_id`, `kind`, `ref`, `ledger_id`, `date`, `symbol`, `side`, `quantity`, `price`, `field`, `broker_value`, `ledger_value`, `difference_bdt`, `amount_bdt`, `commission_bdt`

```sql
WITH b AS (
  SELECT broker_ref, date_format(trade_date, 'yyyy-MM-dd') AS d, UPPER(TRIM(symbol)) AS sym, symbol, side,
         CAST(quantity AS DOUBLE) AS quantity, CAST(price AS DOUBLE) AS price, CAST(commission_bdt AS DOUBLE) AS commission_bdt,
         ROW_NUMBER() OVER (PARTITION BY trade_date, UPPER(TRIM(symbol)), side, CAST(quantity AS DOUBLE) ORDER BY broker_ref) AS rn
  FROM tradeflow_external.broker_statement
),
l AS (
  SELECT id, date_format(to_date(from_utc_timestamp(to_utc_timestamp(created_at, current_timezone()), 'Asia/Dhaka')), 'yyyy-MM-dd') AS d, UPPER(TRIM(symbol)) AS sym, symbol, side,
         CAST(quantity AS DOUBLE) AS quantity, CAST(price_per_share AS DOUBLE) AS price, ROUND(COALESCE(CAST(fees_bdt AS DOUBLE), 0), 2) AS fee,
         ROW_NUMBER() OVER (PARTITION BY to_date(from_utc_timestamp(to_utc_timestamp(created_at, current_timezone()), 'Asia/Dhaka')), UPPER(TRIM(symbol)), side, CAST(quantity AS DOUBLE) ORDER BY created_at, id) AS rn
  FROM tradeflow_ledger.transactions
),
k AS (
  SELECT bank_ref, date_format(value_date, 'yyyy-MM-dd') AS d, CAST(amount_bdt AS DOUBLE) AS amount,
         ROW_NUMBER() OVER (PARTITION BY value_date, ROUND(CAST(amount_bdt AS DOUBLE), 2) ORDER BY bank_ref) AS rn
  FROM tradeflow_external.bank_deposits
),
c AS (
  SELECT id, date_format(to_date(from_utc_timestamp(to_utc_timestamp(created_at, current_timezone()), 'Asia/Dhaka')), 'yyyy-MM-dd') AS d, CAST(amount_bdt AS DOUBLE) AS amount,
         ROW_NUMBER() OVER (PARTITION BY to_date(from_utc_timestamp(to_utc_timestamp(created_at, current_timezone()), 'Asia/Dhaka')), ROUND(CAST(amount_bdt AS DOUBLE), 2) ORDER BY created_at, id) AS rn
  FROM tradeflow_ledger.contributions
),
trades AS (
  SELECT b.broker_ref, b.d AS b_d, b.symbol AS b_symbol, b.side AS b_side, b.quantity AS b_quantity, b.price AS b_price, b.commission_bdt,
         l.id AS ledger_id, l.d AS l_d, l.symbol AS l_symbol, l.side AS l_side, l.quantity AS l_quantity, l.price AS l_price, l.fee,
         ABS(b.commission_bdt - l.fee) > 0.005 AS fee_differs, ABS(b.price - l.price) > 0.005 AS price_differs
  FROM b FULL OUTER JOIN l
    ON b.d = l.d AND b.sym = l.sym AND b.side = l.side AND b.quantity = l.quantity AND b.rn = l.rn
   AND ABS(b.price - l.price) <= 0.1 + 1e-9
)
SELECT issue_id, kind, ref, ledger_id, `date`, symbol, side, quantity, price, field, broker_value, ledger_value, difference_bdt, amount_bdt, commission_bdt
FROM (
  SELECT COALESCE(ledger_id, broker_ref) AS issue_id,
         CASE WHEN ledger_id IS NULL THEN 'broker_only_trade' WHEN broker_ref IS NULL THEN 'ledger_only_trade' ELSE 'mismatched_trade' END AS kind,
         broker_ref AS ref, ledger_id, COALESCE(b_d, l_d) AS `date`, COALESCE(b_symbol, l_symbol) AS symbol, COALESCE(b_side, l_side) AS side,
         COALESCE(b_quantity, l_quantity) AS quantity, COALESCE(b_price, l_price) AS price,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS STRING) WHEN fee_differs THEN 'commission_bdt' ELSE 'price' END AS field,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS DOUBLE) WHEN fee_differs THEN commission_bdt ELSE b_price END AS broker_value,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS DOUBLE) WHEN fee_differs THEN fee ELSE l_price END AS ledger_value,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN CAST(NULL AS DOUBLE) WHEN fee_differs THEN ROUND(commission_bdt - fee, 2) ELSE ROUND(b_price - l_price, 2) END AS difference_bdt,
         CASE WHEN broker_ref IS NULL OR ledger_id IS NULL THEN ROUND(COALESCE(b_quantity, l_quantity) * COALESCE(b_price, l_price), 2) ELSE CAST(NULL AS DOUBLE) END AS amount_bdt,
         CASE WHEN ledger_id IS NULL THEN commission_bdt ELSE CAST(NULL AS DOUBLE) END AS commission_bdt
  FROM trades
  WHERE broker_ref IS NULL OR ledger_id IS NULL OR fee_differs OR price_differs
  UNION ALL
  SELECT COALESCE(c.id, k.bank_ref) AS issue_id,
         CASE WHEN c.id IS NULL THEN 'bank_only_deposit' ELSE 'contribution_only_deposit' END AS kind,
         k.bank_ref AS ref, c.id AS ledger_id, COALESCE(k.d, c.d) AS `date`, CAST(NULL AS STRING) AS symbol, CAST(NULL AS STRING) AS side,
         CAST(NULL AS DOUBLE) AS quantity, CAST(NULL AS DOUBLE) AS price, CAST(NULL AS STRING) AS field, CAST(NULL AS DOUBLE) AS broker_value,
         CAST(NULL AS DOUBLE) AS ledger_value, CAST(NULL AS DOUBLE) AS difference_bdt, COALESCE(k.amount, c.amount) AS amount_bdt,
         CAST(NULL AS DOUBLE) AS commission_bdt
  FROM k FULL OUTER JOIN c ON k.d = c.d AND ABS(k.amount - c.amount) <= 0.005 AND k.rn = c.rn
  WHERE k.bank_ref IS NULL OR c.id IS NULL
) issues
ORDER BY `date`, issue_id
```

parity: match
