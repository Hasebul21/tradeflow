# Zetaris queries

Written by `npm run parity` on 2026-10-22. Each statement is what `sql()` in `src/agent/queries.ts` returns for the params shown, over the datasources `tradeflow_ledger` and `tradeflow_external`.
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
