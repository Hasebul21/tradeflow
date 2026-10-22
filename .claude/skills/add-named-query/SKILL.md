---
name: add-named-query
description: Add or change a named query in src/agent/queries.ts, with its local and Zetaris versions, its tool schema and tests. Use whenever an agent needs data it can't get from the existing queries.
paths: src/agent/queries.ts
---
1. Pick an id in snake_case that says what it returns, such as sector_weights.
2. Write a one-line description the Planner will read: what it returns and when to use it.
3. Define params with zod. Most queries take as_of (yyyy-mm-dd); the between-queries take from and to instead, and reconciliation takes no params. Add others only if needed.
4. local(): call the src/lib function the matching base API uses (see the table in AGENTS.md) and return rows of plain numbers and strings. Never re-implement it.
5. sql(): one Lightning SQL statement over the tradeflow_ledger and tradeflow_external datasources, qualified table names from SHOW DATASOURCE TABLES, no trailing semicolon, aggregation in SQL. A query with no table behind it, such as what_if, has no sql() and runs locally.
6. Make sure the tool schema built from the registry includes it (name = id, description, JSON schema of params).
7. Add a vitest for local() on the seed data, checked against the figures in data/README.md, including that as_of changes the result.
8. Run `npm run parity` if Zetaris is configured, and report any difference.
