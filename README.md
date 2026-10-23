# Tradeflow

A small stock portfolio ledger for the Dhaka Stock Exchange (DSE). You record buys and sells, and it shows open positions, average cost, break-even, unrealised and realised profit or loss, what moved the portfolio this week against the market and its sectors, dividends and bonus shares, and whether the portfolio still follows the rules you set for yourself. It can preview a trade before you make it, and reconcile the ledger against a broker statement and a bank file.

It runs on **synthetic data**. Every price, trade, deposit, announcement and company figure in `data/` is made up by `scripts/seed.mjs`. The trading codes are real DSE symbols so the pages read naturally, but nothing here came from a market, a broker or a bank. There is no login, and Postgres is optional. The base ledger pages read local data. The agents call the Nemotron model through Meterless Nightshift (`METERLESS_BASE_URL`, `src/agent/llm.ts`) and can query Postgres through Zetaris (`src/agent/zetaris.ts`), falling back to local rows; in sample mode they make no network call. Every named query except `what_if` has one Lightning SQL statement in `src/agent/queries.ts`, and `reconciliation`'s statement joins `tradeflow_ledger` and `tradeflow_external` in one query; `npm run parity` compares each with `local()` and writes [`docs/zetaris-queries.md`](docs/zetaris-queries.md).

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
npm run dev -- -p 8000
```

Open http://localhost:8000. Port 3000 is left for the Zetaris console.

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
| `/explain` | The agents: My week, Theses, Pre-trade and Reconcile tabs, each with a date and a button; a result links to its steps. Says when sample mode is on |
| `/explain/queue` | Runs that wait for the owner's decision. Linked from the Explain page and the Guide, not the menu |
| `/explain/runs` | Every run in `logs/`, newest first; `/explain/runs/<run_id>` shows one run's steps. Linked from the Explain page and the Guide |
| `/explain/metrics` | Counts across runs, from the trace files. Linked from the Explain page and the Guide |
| `/guide` | A first-time user's guide: the first run in five steps, how dates work, each page, the words the agents use |

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
npm run eval        # every input example and red-team case in sample mode; writes evals/RESULTS.md
npm run check       # lint, types, tests, then npm run eval -- --no-results at concurrency 1 and 3 (the same checks, no RESULTS.md)
```

`npm run eval` (`scripts/eval.ts`) first runs `scripts/make-fixtures.ts`, which rewrites `evals/redteam/fixtures/` (git-ignored) from `data/` without `data/memory/`: `base`, an unchanged copy; `injected-note`, with trade plan `p-02`'s note replaced by an instruction to the agents; and `injected-announcement`, with announcement `a-066`'s body replaced the same way. It never edits `data/`. It then runs every file in `input_examples/` in name order, then every case in `evals/redteam/cases.json`, in one process, each with its file name or case id as `run_id`. A run without its own `data_dir` uses `base`, so memory starts empty at the start of each eval and carries over between runs (`example_3b` recalls `example_3a`'s review, and `example_7a` corrects it). A case with its own `data_dir` runs every query locally, because that copy is not in Postgres, and each `Query` trace line says so. Each result is checked against `evals/expectations.json` or the case's `expect` block (`real_model` fields only when `SAMPLE_MODE=false`); every result that is not an error must carry `usage`, end its review with the disclaimer line and never say "you should buy", "you should sell" or "you should hold"; and the trace must take the task's path (Planner, Analyst, Evaluator and Writer in order for `explain_week` and `thesis_check`, a `fixed_plan` line with `what_if` and no Planner for `pre_trade`, no Planner for `feedback`). An expectation whose input file does not exist yet, such as `example_8` before the reconcile task, is listed as skipped. Any failure exits 1. The eval runs in sample mode unless the shell sets `SAMPLE_MODE=false`; a sample-mode run replaces the "Sample mode" section of [`evals/RESULTS.md`](evals/RESULTS.md), and a real-model run appends a "Real model, run <n>" section with the provider's host name, the model ids, the `routed_model`, the total `cost_usd` and the commit it measured. A case the provider rate-limits after the retry is marked "rate-limited" and the eval goes on.

#### Running cases in parallel

A real model call can take 1 to 3 minutes, so a run of every case one after the other takes over an hour. Both runners can run independent cases 2 or 3 at a time.

- **The chain rule:** some cases read what an earlier case wrote to memory. `CASE_CHAINS` in `scripts/case-chains.ts` lists them: `example_3a`, `example_3b`, `example_7a`, `example_7b`. A chain's cases always run in that order, one after the other. Different chains, and cases in no chain, may run at the same time.
- **The eval:** `npm run eval -- --concurrency 3` (or `EVAL_CONCURRENCY=3`). The default is 1, which runs as before. Above 1, the chain starts first, and each chain or lone case runs in its own child process on its own temporary copy of its data dir, so no memory passes between chains. A lone case then starts with empty memory instead of what earlier cases stored, so its token count can be lower. `evals/RESULTS.md` keeps the usual case order and columns; a real-model section run above 1 adds a `Concurrency` line. A worker that stops, or a case with no result, fails the eval. Ctrl-C stops the workers and removes the temporary copies.
- **The running app:** `npm run e2e:live -- --concurrency 3 --base http://localhost:8000 --out <dir>` posts each `input_examples/*.json` to `POST /run`, or each red-team case with `--redteam`. A case with its own `data_dir` runs through `npm run agent` on a copy of its fixture instead, with every query local. The chain starts first. The runner waits for each reply, retries a 429 Busy after `Retry-After` (at least 1 s), saves `<dir>/<case>.json` and `<dir>/<case>.trace.jsonl`, and prints one line per case as it finishes, then every case again in case order. It never changes the repo.
- **Exit code of the live runner:** a success or `needs_human` reply is a result. An error reply counts only when the case expects it: status `error` and the same `error_type` in `evals/expectations.json` or `evals/redteam/cases.json`, such as `InvalidInput` for `before-the-data`. Any other reply, such as a 500 `Timeout` or `RateLimited`, is an unexpected error. A case with no reply, or still Busy after the whole wait, has no result. After an unexpected error or no result, the rest of its chain is marked not run. Any unexpected error, no result, missing case or stopped group makes the runner exit 1, and the summary lists them. Ctrl-C stops its `npm run agent` children and removes its temporary dirs.
- **Traces:** each case's old `<dir>/<case>.trace.jsonl` is removed before it runs, and a `logs/` trace is copied only when it changed after the case started. So the memory note never comes from an earlier run.
- **Memory in a live run:** all runs share the server's one data dir. So a case in no chain may or may not recall `example_3a`'s review or `example_7a`'s correction, depending on when it starts, and each case's line names what it recalled (`memory: by_tag=...; by_query=...`, from the trace's `Memory.recall` line).
- **The server's cap:** the server takes at most `MAX_CONCURRENT_RUNS` runs at once (default 2). For a parallel run, start it with `MAX_CONCURRENT_RUNS=3 npm run dev -- -p 8000`. The runner prints a note when `--concurrency` is above the cap.

```sh
SAMPLE_MODE=false npm run eval -- --concurrency 3                                       # the eval, real model
MAX_CONCURRENT_RUNS=3 npm run dev -- -p 8000                                            # terminal 1: the app
npm run e2e:live -- --concurrency 3 --base http://localhost:8000 --out logs/e2e-live    # terminal 2: the live runner
```

To see which model answers, run `npm run try-model` (add `-- --strong` or `-- --fast` for another tier). It sends one short Planner input and prints the source, the requested `meterless/*` id, the model the reply reports, the receipt's `routed_model` and `cost_usd`, whether the reply parsed, the usage and the time. With no key set, or with `SAMPLE_MODE=true`, it uses `src/agent/sample-model.ts`: deterministic code that builds each reply from the input, with no network and no stored answers, and reports usage as an estimate of characters divided by four.

The owner's memory lives in `<data dir>/memory` (`state.json` and `ledger.jsonl`, git-ignored) and is kept by Meterless H-MEM. `vendor/hmem/src` is a copy of `engines/hmem/reference/src` from the Meterless repository, with its `LICENSE` (Apache-2.0); it is never edited. `src/agent/memory.ts` wraps it with `seedOwnerContext` (rules, profile and journal theses), `recall` (corrections and the latest earlier review by tag, then the H-MEM query at top 5 and threshold 0.35) and `remember` (an accepted review, with a `ledger` trace line). H-MEM's reference embedder is a hash and its store is a JSON file, so recall is lexical and tag-based, not semantic search.

The owner's corrections (A5) go through `learnCorrection({ review_run_id, text, wrong_memory_ids?, tracer })` in `src/agent/memory.ts`: the text passes `guards.beforeRemember` (kind `correction`), H-MEM mines it with `hmem.mine("user_correction", text)` (one `Memory` model call, counted in the run's usage), and each mined record gets the tags `correction` and the reviewed week's date with `hmem.store.update`. When mining keeps nothing, the text is added as a `preference` memory from `owner:correction`. Each id in `wrong_memory_ids` gets `hmem.feedback(id, "wrong")`, traced as `Memory.feedback`. The next review recalls every correction by tag, lists it under "What I remembered" and in `output.applied_corrections`, and the sample Analyst puts the sector findings first. A correction is stored as the owner's words, never as an instruction to the agents.

The World Model lives in `<data dir>/memory/world` (git-ignored) and is implemented from the Meterless reference architecture: `vendor/world-model/src` is a copy of `engines/world-model/reference/src` from the Meterless repository, with its `LICENSE` (Apache-2.0); it is never edited. `src/agent/world.ts` keeps one `WorldModel` per data dir. After each accepted run, `recordRun({ run_id, as_of, results })` records what the run's query results show, never model text: each holding (`holding:dse:<symbol>`), each announcement of a holding that an accepted finding cites, with a `mentions` relation to it, the facts `weight_pct`, `latest_eps` and `dividend_owed_bdt`, and a `review_week` context. Every write carries `source { kind: "api", by: "tradeflow-agent", at: "<as_of>T00:00:00Z", runId, url: "run_query:<run_query_id>" }`, and it is traced as one `World.record` line before `run_end`. `about(symbols)` returns each holding's current facts and the latest 3 announcements that mention it, each with its `run_query` url; the Planner and the Analyst get it as `world` for the holdings on `as_of` (plus the trade's symbol for `pre_trade`).

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

`src/agent/agents/` holds one file per agent; its system prompt is the matching file in `src/agent/prompts/`, read as-is. Everything else reaches a model as one JSON user message. `src/agent/context.ts` decides what each model sees: `forModel` cuts a query result to `MAX_ROWS_PER_QUERY` (50) rows and adds `row_count` and `truncated` (for `week_moves` the `PORTFOLIO` row stays first and the holdings are ordered by absolute contribution, so a cut drops the smallest moves); `memoriesForModel` keeps at most `MAX_MEMORIES` (5) memories as id, tags, content and relevance; `catalogueFor` gives a task its named queries; `citedResults` gives the Evaluator and the Writer only the results the findings cite. The full rows stay in the run's result store, keyed by `run_query_id`, which `checkCitations` reads, so a number from a cut row is still citable. `src/agent/run-state.ts` holds what one run shares across its rounds and agents: the query cache keyed by query id and params (a call already made in the run, for example in an earlier round, comes back with the same `run_query_id`, is traced as `Query.cached` and counts no query call), that result store, the usage counters, and the model budget (`BudgetExhaustedError` when `MAX_MODEL_CALLS` or `MAX_TOKENS_PER_RUN` is spent).

| Agent | Model tier | What it does | Where |
|---|---|---|---|
| Analyst | main | Code runs the plan's queries in plan order through the run's cache and `runQuery` (so `guards.beforeQuery`); a step the guard refuses, or `local()` cannot answer, is skipped, traced as `step_skipped` and listed as a gap. One call to the main model with `analyst.md` as-is and one JSON user message (task, question, as_of, trade, focus, memories, world, the results trimmed by `forModel`, previous_findings and feedback, which are null in round 1 and the last round's findings and the Evaluator's fix on a retry). The task's named queries are offered as native tools (`toolsFor`: OpenAI function definitions, name = query id, parameters = its params as JSON schema). A tool call is run by code the same way (guard, cache, budget), traced as `tool_call`, and sent back as a tool message; a blocked, refused or malformed call goes back as a tool message with the reason, never a crash; at most `MAX_TOOL_ROUNDS` (2) such rounds, then one call without tools so the model must answer; no tool calls means the planned results alone. Every model call counts against `MAX_MODEL_CALLS` and the token budget. The reply is validated with zod (one of nine kinds, a verdict of confirmed, contradicted, open or null, a numbers list that may be empty) and goes through `afterModel`; a reply that fails either ends the call as a structured error (`BadJson` or `Blocked`, recoverable) with what was gathered. A result with no rows is a gap, never a guess. In sample mode the findings come from the results alone: a move finding for the PORTFOLIO row and for the three holdings with the largest absolute contribution ("<SYMBOL> rose or fell x% over the week, y points against its sector index (stock-specific or in line with sector)"), the sector that moved most against DSEX, each price-sensitive announcement of a holding (worded "after", never "because of"), each dividend (paid or owed), each rule finding plus the sector furthest from its target, a "Last week" comparison when a review memory was recalled, a finding for the symbol a retry's feedback names, and gaps for an empty result, a prediction, a topic no result covers and an off-topic question | `src/agent/agents/analyst.ts`, `src/agent/prompts/analyst.md`, `src/agent/agents/analyst.test.ts`, `src/agent/run-state.ts` |
| Planner | strong (`llm.ts` falls back to main) | Picks at most `MAX_PLAN_STEPS` (5) named queries for `explain_week` or `thesis_check`, each with a why, from the task's catalogue. A step whose query id is not in the catalogue, or whose params fail the query's schema, is dropped and traced as `step_dropped` and never run; invalid steps are dropped before a longer plan is cut to the first 5 (traced as `plan_cut`). The kept plan goes through `afterModel`; a refused plan is a `PlanBlockedError`. Each planned step is one `plan_step` trace line with its why and `target_agent` Analyst. In sample mode the plan comes from the input alone: for `explain_week`, `week_moves`, `sector_vs_stock`, `announcements_between`, `dividends_between` and `rule_findings`, with `declined_advice` when the question asks whether to buy, sell or hold | `src/agent/agents/planner.ts`, `src/agent/prompts/planner.md`, `src/agent/agents/planner.test.ts` |
| Evaluator | fast | Code checks the Analyst's draft first, in this order, each traced as `code_check` with its reason: `checkCitations` (every number is in a cited row of this run), `afterModel` on the draft (no advice, every finding matches the schema), then coverage (`explain_week`: the holding with the largest absolute contribution in the run's `week_moves` rows, the `PORTFOLIO` row aside, is the subject of a finding; `thesis_check`: every journal id in the run's journal rows has a thesis finding with a verdict; `pre_trade`: a `pre_trade` finding; `reconcile`: every `issue_id` in the run's reconciliation rows has a finding). A failed check is a rejection with a one-sentence fix written by code, such as "Explain BXPHARMA: it is the largest move of the week and has no finding.", and no model call. A draft that passes goes to the fast model with `evaluator.md` as-is and one JSON user message (task, question, as_of, memories, findings, gaps and, through `citedResults`, only the rows the findings cite); the reply is three whole scores from 0 to 3 and a fix. The total out of 9 as a fraction rounded to two decimals is the trace's `confidence` (7 of 9 is 0.78); the three scores go to `output_summary`. One verdict line: `accept` (`target_agent` Writer) at 7 or more, else `reject` with the fix in `why` and `target_agent` Planner for `explain_week` and `thesis_check`, Analyst for the fixed chains; when the model scores below 7 and names no fix, code writes one from the lowest score. A reply that fails the schema or the guard is a structured error (`bad_reply`), never a crash. When the model returns no content (HTTP 502 `empty_response`), `llm.ts` makes its one retry as the same request at `max_tokens` 8000, traced as `empty_response_retry`; Nightshift never gets a reasoning switch on any tier, and only OpenRouter keeps `reasoning { enabled: false }` for the fast tier. If the scoring call still fails with a 502, the draft is accepted on the code checks alone: one `score_unavailable` line (`target_agent` Writer, `confidence` null), `output.scores` null, the run goes on to the Writer, and the Explain page and `npm run eval` show "score unavailable", never 0. In sample mode: accuracy 3 when every finding has a cite and a numbers list (an empty list is fine), else 1; appropriateness 3 when the task's required kind is present (move, thesis, pre_trade or reconciliation), else 2; actionability 3 with two or more findings, else 2; the fix names the missing kind when the total is below 7 | `src/agent/agents/evaluator.ts`, `src/agent/prompts/evaluator.md`, `src/agent/agents/evaluator.test.ts` |
| Writer | strong (`llm.ts` falls back to main) | One call with `writer.md` as-is and one JSON user message: the accepted findings, each with the rows it cites (`cited_rows`: the rows of each cited result that name the finding's subject, or the whole trimmed result when none does), the gaps, `declined_advice`, the escalation, the recalled memories (id, tags, content) and the applied corrections (those tagged `correction`). Code checks the reply (`checkReview`, traced as `code_check`): every number in the summary, the review and the memory note is in an accepted finding's numbers, in a cited row or in a recalled memory's content, rounding to one decimal place (digits in dates, years, ids, run_query_ids and `[q:...]` tags are not numbers); the last line of the review is "This is a review of your own records, not financial advice."; `afterModel` passes. A failure gets one retry with the same input plus `retry_reason` (traced as `retry`); a second failure returns `ok: false` with the reason and the draft, which the loop turns into `needs_human`. An accepted review's `memory_note` is stored through `memory.remember`, so through `beforeRemember` with kind `review`; a refused write keeps the review and names the reason in `memory_reason`. When `afterModel` saw injection wording in the accepted reply, `remember` is not called at all: the review stays ok, `memory_id` is null, `memory_reason` says why and the skip is traced as `memory_skipped`. In sample mode the review is Markdown in `writer.md`'s shape: a summary with the portfolio's move against DSEX and the largest holding move; one bullet per accepted finding ending with its `[q:<run_query_id>]` tags, in this order for `explain_week`: the `PORTFOLIO` move, the largest holding move with its announcement folded in (after "<title>" on <date>), each rule finding quoting the rule's message, the sector finding, the dividends, the "Last week" comparison, then the remaining moves; a "What I remembered" section with one plain line per recalled memory ("Last week's review (<date>): ..." or "Applied your correction from <date>: ..."); "What to look at next"; "Not covered: ..." when there are gaps; the disclaimer last. The memory note reads "Week to <as_of>: <holding> <x>% of the portfolio, above the <limit>% limit; <SYMBOL> fell <x>%, the largest move." or "no rule broken" | `src/agent/agents/writer.ts`, `src/agent/prompts/writer.md`, `src/agent/agents/writer.test.ts` |
| Reconcile (A4) | main (Analyst), fast (Evaluator), strong (Writer) | `task: "reconcile"` (`as_of` optional, the last trading day when missing) is a fixed chain in code: one Orchestrator `fixed_plan` line and no Planner call; code runs `reconciliation` (through Zetaris, with the local fallback), then `journal_for_symbol` for each symbol a trade difference names, traced as a `branch` line. The Analyst gets no tools and writes one `reconciliation` finding per `issue_id` (the ledger id for a mismatched or ledger-only trade, `broker_ref` for a broker-only trade, `bank_ref` for a bank-only deposit, the contribution id for a contribution-only one); the Evaluator's coverage check needs a finding per `issue_id`; a rejection goes back to the Analyst. `output.proposals` is `[{ issue_id, explanation, proposed_fix, cites, status: "awaiting_approval" }]`, with each `proposed_fix` built by code from the row (`reconcile-fix.ts` `proposedFix`), and the run ends `needs_human` with `stop_reason` null. `task: "reconcile_approve"` with `review_run_id` and `issue_id` applies one fix with no model: code reruns the reconciliation `local()` on the current files (source `local`), takes the row with that `issue_id` and calls `appendContribution` (bank-only deposit) or `appendTransaction` (broker-only trade, its commission as `fees_bdt`); a commission difference, a ledger-only trade or a contribution-only deposit is a manual check and writes nothing. It writes only with `NODE_ENV=production` (Docker) or `TRADEFLOW_DATA_DIR` set to a directory other than `data/`; otherwise it returns `needs_human` and writes nothing. Each approval is one `approval` trace line and an owner decision stored through `beforeRemember` with kind `decision`. Zetaris shows the old rows until `npm run db:load`. The Explain page has a Reconcile tab with an Approve button per proposal | `src/agent/reconcile-fix.ts`, `src/agent/orchestrator.ts` (`approveRun`), `src/agent/reconcile.test.ts`, `src/app/explain/view.tsx` |
| Router (A6) | fast | A request with no `task` is routed after the input checks (empty question, bad or out-of-range date, unknown symbol) pass and before any other model call: the Router reads the question, the plan id, the instruments and the four tasks, and returns `{ task, trade?, plan_id? }`. Code accepts `pre_trade` only when the question holds a number or `plan_id` is set (else `explain_week`, traced "no quantity"); a reply that fails its schema, or is not JSON after `llm.ts`'s retry, routes to `explain_week` (traced `route` with why "invalid router reply") and never ends the run. A routed trade then goes through the same checks as a given one (symbol in `instruments.json`, positive whole quantity); a failure is `InvalidInput`. The Router call counts in `usage` and `MAX_MODEL_CALLS`. An advice question with no quantity ("Should I sell X?") goes to `explain_week`, which declines the advice. A missing `as_of` is the last trading day for every task. In sample mode: symbol, side word and quantity give `pre_trade`; "reason", "thesis" or "still hold" give `thesis_check`; "broker", "bank statement" or "reconcile" give `reconcile`; everything else gives `explain_week`. The run_end line carries the final status, `stop_reason` and `escalation_rule`; `/explain/queue` lists every `needs_human` run from it, and `/explain/runs/<run_id>` shows a run's trace as a timeline with the Proof cards | `src/agent/agents/router.ts`, `src/agent/prompts/router.md`, `src/agent/agents/router.test.ts`, `src/agent/trace-read.ts`, `src/app/explain/runs/[run_id]/`, `src/app/explain/queue/` |
| Orchestrator | none: code | `src/agent/orchestrator.ts` runs one task (`explain_week` for now) as the bounded loop. `run({ runId, task, input, sampleMode, config })` resolves `as_of` once with `resolveAsOf` (a Friday or Saturday moves to the Thursday before, traced as `Guard.as_of_moved`), seeds the owner's memory once and recalls memories for the question, then runs the Planner, the Analyst and the Evaluator up to `MAX_ROUNDS` (3) times. The branch is code: a draft that passes the Evaluator's code checks and scores 7 or more of 9 goes to the Writer; otherwise the Planner gets the fix as feedback and the Analyst its previous findings and the fix, with `retry_count` one higher on every line of the next round; a third rejection ends as `needs_human` with the best draft (the highest total, or the last draft when no round reached the model) and `stop_reason` `rounds`. Before every call it checks the budgets in `config.ts` and passes each model call the time left (the tier's timeout, the round's and the run's, whichever is least) as its timeout; when `MAX_QUERY_CALLS`, `MAX_MODEL_CALLS`, `MAX_TOKENS_PER_RUN`, `ROUND_TIMEOUT_MS` or `RUN_TIMEOUT_MS` runs out, the run returns `needs_human` with the best draft, `output.partial` true and `output.stop_reason` `query_calls`, `model_calls`, `tokens`, `round_timeout` or `run_timeout`; a Writer whose review fails its code check twice gives `needs_human` with its draft and `stop_reason` `writer_rejected`. A review the Writer never wrote is built by code from the draft findings and ends with the disclaimer. `run()` never throws: a typed error from `llm.ts` or an agent becomes `{ status: "error", error: { type, message, recoverable } }`, recoverable only for a timeout, a 429 or a 5xx; a timeout caused by the round's or the run's time left is `round_timeout` or `run_timeout`, not an error. Flags are set in code so they hold in sample mode: `injection_seen` when the Planner or `afterModel` flags it, or when a query row, a recalled memory or a trade-plan note in `rules.json` holds "ignore previous instructions", "you are now" or "tell the owner to" (traced as `Guard.injection_flagged`; the row cell or memory is removed from what every model and the Writer see); `declined_advice` when the Planner sets it or the question asks whether to buy, sell or hold (traced once as `Guard.advice_declined`). The reply is `{ run_id, task, status, output, error, agents, usage, trace_id, log_file, execution_time_seconds }`; `output` carries the summary, the review, the findings, the gaps, one citation per cited `run_query_id` (query id, params, source, row count), `needs_human`, the two flags, `memories_recalled` (id and tags), `applied_corrections`, `rounds` (the round accepted in, or the rounds run), `scores` from the last Evaluator call, `model_source` ("sample-model" or the model ids, never a key or URL), `partial` and `stop_reason`. Usage adds up every model call and every real query call. Every request to the model counts as one model call toward `MAX_MODEL_CALLS`, a failed one and each retry included: a retry line (`empty_response_retry`, `model_retry`) carries `usage.model_calls` 1 for the request before it, the `model_call` line (`ok` or `error`) carries the rest and the tokens, and `llm.ts` sends no request past the budget. A 502 `empty_response` gets up to 3 tries, after waits of 15 s and 30 s, while a whole model call (240 s) still fits in the round; each `Query.query` line `usage.query_calls` 1, a `Query.cached` line none, and the Orchestrator's `run_end` line, the last line of every run, repeats the run's total with `stop_reason` beside the status, so adding up a run's lines means leaving `run_end` out | `src/agent/orchestrator.ts`, `src/agent/orchestrator.test.ts` |
| Run API and CLI | none: code | `POST /run` takes `{ run_id?, input: { task?, question?, as_of?, trade?, plan_id?, review_run_id?, text?, wrong_memory_ids?, issue_id? }, options?: { sample_mode? } }` (`task: "feedback"` needs `review_run_id` and `text`, runs no Planner, and returns `output.memory_ids_added`) and returns the orchestrator result: 200 for `success` or `needs_human`, 400 for `InvalidInput` (a bad run id, an empty question on `explain_week`, an unknown task, a malformed or out-of-data `as_of`), 500 for any other `error`; the error body is `{ status: "error", error, usage }` with zero usage when it failed before a call. A missing `run_id` is made with `crypto.randomUUID` and returned; a missing `task` is `explain_week`; a missing `as_of` is the last trading day. Sample mode follows `config.ts`; `options.sample_mode` true turns it on for one request when `SAMPLE_MODE` is empty, and `SAMPLE_MODE` wins over `options`. `GET /run/<run_id>` returns `{ run_id, done, lines }` from `logs/trace-<run_id>.jsonl` (400 for an id outside `^[A-Za-z0-9_-]{1,80}$`, 404 `NotFound` for no file). `npm run agent -- <input.json>... [--out <dir>]` runs the files in order in one process (memory carries over), prints each result as JSON, then the summary and review text. | `src/agent/request.ts`, `src/app/run/route.ts`, `src/app/run/[run_id]/route.ts`, `scripts/agent.ts`, `src/agent/request.test.ts`, `src/app/run/route.test.ts` |
| Stop a run and cap the server | none: code | `POST /run/<run_id>/cancel` stops a running run and returns `{ run_id, cancelled: true }` (400 for a bad id, 404 `NotRunning` when the id is not running). The run ends like a spent limit: `needs_human`, `output.partial` true, `output.stop_reason` `cancelled`, the best draft so far, its usage so far, one Orchestrator `cancelled` line (why "cancelled by the owner") and the usual `run_end` line; it writes no memory and no World Model facts. Cancelling a briefing cancels its running children and skips the ones not started. `GET /runs/active` lists the runs in this process: `[{ run_id, task, parent_run_id, started_at, elapsed_ms }]`. `MAX_CONCURRENT_RUNS` (default 2) caps the top-level runs `POST /run` takes at once: beyond it the answer is 429 `Busy` with `Retry-After: 5`, zero usage and no trace file; briefing children, the Explain page's actions and `npm run agent` don't count. The cap is checked when the request arrives, so two requests that arrive within the time it takes to read a body can both pass. The Explain page shows a Stop button while a run works and "Stopped by you" on the result; `/explain/queue` lists the stopped run. | `src/agent/registry.ts`, `src/app/run/[run_id]/cancel/route.ts`, `src/app/runs/active/route.ts`, `src/agent/cancel.test.ts`, `src/agent/registry.test.ts`, `src/app/run/cancel.test.ts`, `src/app/run/busy.test.ts` |

## Guards

`src/agent/guards.ts` holds the runtime checks. Each guard writes one trace line as agent `Guard` and returns `{ ok: true }` or `{ ok: false, reason }`; a block has action `block` and status `blocked`.

| Guard | Where it runs | What it blocks |
|---|---|---|
| `beforeQuery` | `runQuery`, before any query | A query id that is not in the registry, params that fail the query's schema, an `as_of` outside the dates of the bars, a `what_if` with an unknown symbol or a quantity that is not a positive whole number, and a run whose query budget is spent. A Friday or Saturday `as_of` moves to the Thursday before and is traced as `as_of_moved` |
| `afterModel` | After each model reply | A finding that fails the finding schema, wording that tells the owner to buy, sell or hold, and a thesis verdict other than confirmed, contradicted or open in the `thesis_check` task. Injection wording sets `injection_seen` without blocking |
| `checkCitations` | Over the findings of a draft | A finding with no `run_query_id`, a cite that does not exist in the run, and a number in `numbers` or in the claim that is not in the cited rows (or in a listed memory) |
| `beforeRemember` | `remember`, before a memory write | Anything but a review's note, an owner correction or an owner decision; raw rows; text over 600 characters; text that reads like an instruction to the agents (the same injection phrases `afterModel` detects) |

## Where it came from

This is a cut-down, public version of a private portfolio app. The ledger maths, commission rule, number formatting and DSE calendar are copied from it unchanged. The private version's login, database, email reports, price scraping and AI features were removed, and the data was replaced with the synthetic set above. `PRE-EXISTING.md` lists what existed before the hackathon build window.
