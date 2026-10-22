# Tradeflow

A small stock portfolio ledger for the Dhaka Stock Exchange (DSE). You record buys and sells, and it shows open positions, average cost, break-even, unrealised and realised profit or loss, what moved the portfolio this week against the market and its sectors, dividends and bonus shares, and whether the portfolio still follows the rules you set for yourself. It can preview a trade before you make it, and reconcile the ledger against a broker statement and a bank file.

It runs on **synthetic data**. Every price, trade, deposit, announcement and company figure in `data/` is made up by `scripts/seed.mjs`. The trading codes are real DSE symbols so the pages read naturally, but nothing here came from a market, a broker or a bank. There is no login and no network call; Postgres is optional.

## Run it locally

These steps are for a fresh Mac. They work the same on Linux.

### 1. Install the tools

| Tool | Version | Check | How to get it | Needed for |
|---|---|---|---|---|
| Git | any recent | `git --version` | Comes with the Xcode command line tools: `xcode-select --install` | Getting the code |
| Node.js | 20 or newer (22 recommended) | `node -v` | [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`, or the installer from nodejs.org | Everything |
| npm | comes with Node | `npm -v` | Installed with Node | Everything |
| Docker Desktop | any recent | `docker --version` and `docker compose version` | docker.com, then start the app | Only Postgres and the Docker image |

The app, the tests and the seed need only Node. Docker is needed only to run Postgres for `npm run db:load`, or to run the app as a container.

### 2. Get the code

```sh
git clone https://github.com/Hasebul21/tradeflow
cd tradeflow
npm install
```

### 3. Create `.env` (optional)

Nothing is required for `npm run dev`. Create a `.env` only for the commands that need one:

```sh
cp .env.example .env
```

| Variable | What it is | Required? | Example | Used by |
|---|---|---|---|---|
| `NEXT_PUBLIC_TRADE_COMMISSION_RATE` | Broker commission as a decimal | Optional, default `0.004` | `0.004` | The app, when it fills in fees |
| `TRADEFLOW_DATA_DIR` | Folder of the data files | Optional, default `./data` | `./data` | The app, `npm run seed`, `npm run db:load` |
| `SEED_END_DATE` | Last trading day of the generated data | Optional, default `2026-10-01` | `2026-10-01` | `npm run seed` |
| `PGPASS` | Password of the `postgres` user in the Postgres container | Only for Postgres | `choose-a-password` | `docker compose` |
| `DATABASE_URL` | The Postgres server `db:load` writes to | Only for Postgres | `postgres://postgres:<PGPASS>@localhost:5432/postgres` | `npm run db:load` |
| `DATABASE_URL_EXTERNAL` | The same server as an outside reader reaches it | Optional | `postgres://zetaris_ro:<password>@<host>:5432/tradeflow_ledger` | Nothing here; kept for an external reader |
| `ZETARIS_DB_PASSWORD` | Password for the read-only role `zetaris_ro` | Optional; without it no role is made | `choose-another-password` | `npm run db:load` |

`.env` is never committed and never copied into the Docker image. Values already set in the shell win over `.env`. If a password has characters such as `@`, `/` or `:`, URL-encode it inside `DATABASE_URL`.

### 4. Run the app

```sh
npm run dev
```

Open http://localhost:3000.

| Page | What it is for |
|---|---|
| `/` Portfolio | Headline numbers (value, week move against DSEX, dividend income), what moved the portfolio this week, the rules broken, and every holding. Has an as-of date picker |
| `/transactions` | Record a buy or a sell, with an optional journal note; **Preview** shows what the trade does to weights and rules before you save |
| `/journal` | Why each trade was made, with the trade it belongs to |
| `/history` | Every sell with its realised P/L, and every dividend and bonus issue |
| `/announcements` | Company announcements (synthetic), with "my holdings only" and a symbol filter |
| `/instruments` | Every symbol with price, holding, latest EPS and trailing P/E. Has an as-of date picker |
| `/instruments/<symbol>` | One company: price against its sector, holding, quarters, dividends, announcements and journal notes |
| `/sector-indices` | Each sector index against DSEX over 5, 20 or 60 sessions |
| `/sources` | The broker statement and the bank file, as they are |
| `/reconciliation` | The broker statement against the ledger and the bank file against deposits; reports only |
| `/invested` | Deposits against the cost and value of open positions |
| `/rules` | Position limit, sector targets against actual weights, and trade plans. Has an as-of date picker |
| `/settings` | The owner's preferences (`data/profile.json`) |

| API | What it returns |
|---|---|
| `GET /api/portfolio?as_of=` | The portfolio page as JSON |
| `GET /api/transactions?as_of=` | The ledger, oldest first |
| `GET /api/announcements?symbol=&from=&to=` | Announcements, newest first |
| `GET /api/attribution?as_of=&sessions=` | Each holding's and sector's share of the move, against its sector index and DSEX |
| `GET /api/sector-indices?as_of=&sessions=` | Each sector index's move, and DSEX's |
| `GET /api/fundamentals?symbol=&as_of=` | Reported quarters, quarter-on-quarter change and trailing P/E |
| `POST /api/what-if` | Before and after for a trade `{ symbol, side, quantity, price?, as_of? }`; saves nothing |
| `GET /api/reconciliation` | Matches and differences between the sources and the ledger |
| `GET /api/journal?symbol=` | Journal entries |
| `GET /api/profile` | The owner's preferences |
| `GET /api/health` | `{ status, data_dir_readable, files }` with a row count per file |
| `GET /api/openapi.json` | An OpenAPI 3.1 description of every API above |

`as_of` is a date as `YYYY-MM-DD`. A Friday or Saturday falls back to the Thursday before. A date before or after the data returns HTTP 400 with a message saying where the data starts or ends.

### 5. The data

The data lives in `data/` as JSON files, plus two CSV files in `data/sources/`. `data/README.md` describes every file, its fields, the story the data tells and the test cases planted in it.

```sh
npm run seed                          # rewrite data/ from scripts/seed-data.mjs
SEED_END_DATE=2026-10-08 npm run seed # end the data on another trading day
```

The seed is fixed: two runs with the same `SEED_END_DATE` write identical files. Changing the end date moves every date (bars, trades, announcements, dividends) so the data ends on that trading day, with the same story; a Friday or Saturday ends on the Thursday before. The story tests in `src/test/story.data.test.ts` assume the default end date of Thursday 1 October 2026. Saving a form in the app rewrites one file whole; `npm run seed` puts every file back. Set `TRADEFLOW_DATA_DIR` to keep the data somewhere else.

### 6. Postgres (optional)

Load the same files into Postgres, for tools that read SQL.

1. Put two passwords of your choice in `.env`: `PGPASS`, and `ZETARIS_DB_PASSWORD` if you want the read-only role.
2. Start Postgres 17:

   ```sh
   docker compose up -d
   ```

3. Set `DATABASE_URL=postgres://postgres:<PGPASS>@localhost:5432/postgres` in `.env`, with your `PGPASS` in place of `<PGPASS>`.
4. Load the data:

   ```sh
   npm run db:load
   ```

It creates two databases if they are missing, and drops and recreates their tables in one transaction each:

- `tradeflow_ledger`: `instruments`, `bars`, `transactions`, `contributions`, `rule_settings`, `sector_targets`, `trade_plans`, `corporate_actions`, `index_bars`, `sector_index_bars`, `journal`, `profile`
- `tradeflow_external`: `broker_statement`, `bank_deposits`, `announcements`, `fundamentals`

Columns are named exactly like the JSON and CSV fields, with `date`, `timestamptz`, `numeric`, `bigint`, `boolean`, `text` and `text[]` types. With `ZETARIS_DB_PASSWORD` set it also creates (or updates) the login role `zetaris_ro`, which may connect to both databases and only `SELECT`. It prints the row count of every table, and never the connection string or a password. Running it again is safe.

Check it and stop it:

```sh
docker compose exec postgres psql -U postgres -l   # lists tradeflow_ledger and tradeflow_external
docker compose down                                # stop; the data stays in the volume
docker compose down -v                             # stop and delete the volume
```

### 7. Run as a Docker image

```sh
docker build -t tradeflow .
docker run --rm -p 3000:3000 tradeflow
```

Open http://localhost:3000. The image carries the data that was in `data/` when it was built. To pass settings, use `docker run --rm -p 3000:3000 --env-file .env tradeflow`; to listen on another port inside the container, add `-e PORT=4000 -p 4000:4000`. The image has a `HEALTHCHECK` on `/api/health`; `docker ps` shows it as healthy once the app answers.

### 8. Checks

```sh
npm test            # unit tests, the story tests on data/, and the route tests (vitest)
npm run lint        # eslint
npx tsc --noEmit    # types
npm run build       # production build
```

To see which model answers, run `npm run try-model` (add `-- --strong` or `-- --fast` for another tier). It sends one short Planner input and prints the source, the requested `meterless/*` id, the model the reply reports, the receipt's `routed_model` and `cost_usd`, whether the reply parsed, the usage and the time. With no key set, or with `SAMPLE_MODE=true`, it uses `src/agent/sample-model.ts`: deterministic code that builds each reply from the input, with no network and no stored answers, and reports usage as an estimate of characters divided by four.

The owner's memory lives in `<data dir>/memory` (`state.json` and `ledger.jsonl`, git-ignored) and is kept by Meterless H-MEM. `vendor/hmem/src` is a copy of `engines/hmem/reference/src` from the Meterless repository, with its `LICENSE` (Apache-2.0); it is never edited. `src/agent/memory.ts` wraps it with `seedOwnerContext` (rules, profile and journal theses), `recall` (corrections and the latest earlier review by tag, then the H-MEM query at top 5 and threshold 0.35) and `remember` (an accepted review, with a `ledger` trace line). H-MEM's reference embedder is a hash and its store is a JSON file, so recall is lexical and tag-based, not semantic search.

### 9. Troubleshooting

| Problem | What to do |
|---|---|
| Port 3000 is in use | `lsof -i :3000` shows what holds it. Or use another port: `npm run dev -- -p 3001`, or `docker run -p 3001:3000 tradeflow` |
| Port 5432 is in use | Another Postgres is running. Stop it, or change the port in `docker-compose.yml` to `"5433:5432"` and use `localhost:5433` in `DATABASE_URL` |
| `Cannot connect to the Docker daemon` | Start Docker Desktop and wait until `docker info` works |
| `docker compose` says `Set PGPASS` | Put `PGPASS` in `.env`, or `export PGPASS=...` in the shell |
| Node is too old, or `npm install` fails | `node -v` must show 20 or newer. `nvm install 22 && nvm use 22`, then `rm -rf node_modules && npm install` |
| `db:load failed: DATABASE_URL is not set` | Add `DATABASE_URL` to `.env` |
| `db:load failed: ECONNREFUSED` | Postgres is not up yet. `docker compose ps` should show it as healthy; wait a few seconds and try again |
| `db:load failed: 28P01 password authentication failed` | The password in `DATABASE_URL` does not match. Postgres keeps the `PGPASS` it was first started with; to start over, `docker compose down -v` then `docker compose up -d` |
| A page says "No prices for that date" | The `as_of` date is outside the data. Use the date picker, or remove `?as_of=` |
| The pages are empty | `data/` is missing or empty. Run `npm run seed` |

## How the numbers work

- **Average cost** folds the buy commission into the cost of the shares. Selling removes cost at the running average, so realised profit never leaks into the invested total.
- **Break-even** is the price at which a sell would return exactly the cost after the sell commission: `avgPrice / (1 - 0.004)`.
- **Unrealised P/L** is `(last price - break-even) x shares`, so it already carries both commissions.
- **Realised P/L** on a sell is `(sell price - average cost before the sell) x shares - sell fee`.
- **This week** is the close-to-close change over the last five trading sessions (the DSE trades Sunday to Thursday), for the shares held now.
- **Dividends** are paid on the shares held at the end of the record date. **Bonus shares** are added as zero-cost buys on the day they are credited, rounded down to whole shares, so the average cost falls and no cash moves.
- **What moved the portfolio** splits the week's move into each holding's part, `(close now - close five sessions ago) x shares held now`, so the parts add up to the whole. Each stock's move is set against its sector index: within 2 percentage points it is "in line with sector", otherwise "stock-specific". This is arithmetic; it does not say why.
- **Trailing P/E** is the last close over the last four quarters' EPS, or over the reported quarters scaled to a year when fewer than four exist; the API says which.
- **As of a date**, every view uses only what was known by the end of that session: trades, bars, deposits, plans, dividends and quarters reported by then.
- **Rules** are checked against market value: no single stock above the limit, each sector within a tolerance of its target, and trade plans whose target price has been reached.
- **Reconciliation** pairs a broker row with a ledger trade on the same day, symbol, side and shares, at a price within Tk 0.10, and reports any field that differs. A bank credit pairs with a deposit on the same day for the same amount.

The ledger maths lives in `src/lib/portfolio.ts`, `src/lib/rules.ts` and `src/lib/market/quotes.ts`; the newer parts in `src/lib/corporate-actions.ts`, `attribution.ts`, `what-if.ts`, `reconcile.ts`, `fundamentals.ts` and `portfolio-view.ts`. Each has tests beside it.

## How the code is laid out

- `src/lib/`: data loading and all the maths. No UI code.
- `src/app/**/page.tsx`: server components that load data and pass plain values to a `view.tsx` beside them.
- `src/app/**/view.tsx` and `src/components/ui/`: client components built with [Ant Design](https://ant.design) 6. The theme is in `src/components/ui/providers.tsx`; the fonts (Source Sans 3 for text, Source Serif 4 for headings) are fetched by `next/font` at build time and served by the app.
- `src/app/api/**/route.ts`: the JSON APIs, described in `src/lib/openapi.ts`.
- `scripts/`: the seed (`seed.mjs`, `seed-data.mjs`) and the Postgres loader (`load-postgres.mjs`, `db-schema.mjs`).

## Agents

`src/agent/agents/` holds one file per agent; its system prompt is the matching file in `src/agent/prompts/`, read as-is. Everything else reaches a model as one JSON user message. `src/agent/context.ts` decides what each model sees: `forModel` cuts a query result to `MAX_ROWS_PER_QUERY` (50) rows and adds `row_count` and `truncated` (for `week_moves` the `PORTFOLIO` row stays first and the holdings are ordered by absolute contribution, so a cut drops the smallest moves); `memoriesForModel` keeps at most `MAX_MEMORIES` (5) memories as id, tags, content and relevance; `catalogueFor` gives a task its named queries; `citedResults` gives the Evaluator and the Writer only the results the findings cite. The full rows stay in the run's result store, keyed by `run_query_id`, which `checkCitations` reads, so a number from a cut row is still citable.

| Agent | Model tier | What it does | Where |
|---|---|---|---|
| Planner | strong (`llm.ts` falls back to main) | Picks at most `MAX_PLAN_STEPS` (5) named queries for `explain_week` or `thesis_check`, each with a why, from the task's catalogue. A step whose query id is not in the catalogue, or whose params fail the query's schema, is dropped and traced as `step_dropped` and never run; invalid steps are dropped before a longer plan is cut to the first 5 (traced as `plan_cut`). The kept plan goes through `afterModel`; a refused plan is a `PlanBlockedError`. Each planned step is one `plan_step` trace line with its why and `target_agent` Analyst. In sample mode the plan comes from the input alone: for `explain_week`, `week_moves`, `sector_vs_stock`, `announcements_between`, `dividends_between` and `rule_findings`, with `declined_advice` when the question asks whether to buy, sell or hold | `src/agent/agents/planner.ts`, `src/agent/prompts/planner.md`, `src/agent/agents/planner.test.ts` |

## Guards

`src/agent/guards.ts` holds the runtime checks. Each guard writes one trace line as agent `Guard` and returns `{ ok: true }` or `{ ok: false, reason }`; a block has action `block` and status `blocked`.

| Guard | Where it runs | What it blocks |
|---|---|---|
| `beforeQuery` | `runQuery`, before any query | A query id that is not in the registry, params that fail the query's schema, an `as_of` outside the dates of the bars, a `what_if` with an unknown symbol or a quantity that is not a positive whole number, and a run whose query budget is spent. A Friday or Saturday `as_of` moves to the Thursday before and is traced as `as_of_moved` |
| `afterModel` | After each model reply | A finding that fails the finding schema, wording that tells the owner to buy, sell or hold, and a thesis verdict other than confirmed, contradicted or open in the `thesis_check` task. Injection wording sets `injection_seen` without blocking |
| `checkCitations` | Over the findings of a draft | A finding with no `run_query_id`, a cite that does not exist in the run, and a number in `numbers` or in the claim that is not in the cited rows (or in a listed memory) |
| `beforeRemember` | `remember`, before a memory write | Anything but a review's note, an owner correction or an owner decision; raw rows; text over 600 characters |

## Where it came from

This is a cut-down, public version of a private portfolio app. The ledger maths, commission rule, number formatting and DSE calendar are copied from it unchanged. The private version's login, database, email reports, price scraping and AI features were removed, and the data was replaced with the synthetic set above. `PRE-EXISTING.md` lists what existed before the hackathon build window.
