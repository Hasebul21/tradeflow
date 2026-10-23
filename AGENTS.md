# AGENTS.md

Instructions for any coding agent working in this repository (Claude Code, or any other). Read it before every task.

Claude Code reads the kit from `.claude/`: the skills, rules and agents, and `.claude/hooks/guard-adapter.mjs`, which runs the guards in `.claude/hooks/` before every read, shell command and prompt. `scripts/claude-kit.test.mjs` tests the guards.

## What this is

Tradeflow is a stock portfolio ledger for the Dhaka Stock Exchange on synthetic data. Everything at the git tag `pre-hackathon` existed before the Open Agent Hackathon 2026 (see `PRE-EXISTING.md`): the ledger, announcements, dividends, the broker and bank files, DSEX and sector indices, the journal, attribution, the what-if preview, reconciliation, fundamentals, the profile, the APIs, Docker and the Postgres loader. The hackathon work is the AI layer only: a small team of agents that explains the week (A1), checks the owner's trade theses (A2), reviews a trade before it is saved (A3), explains reconciliation differences (A4) and learns from the owner's corrections (A5), citing the query behind every number.

It is a review tool. It never recommends buying, selling or holding, and it never saves a trade or changes the ledger without the owner's approval.

## Layout

```text
src/lib/                 pre-existing maths and data access. Reuse, don't rewrite
  portfolio.ts rules.ts market/quotes.ts      holdings, P/L, weights, rule checks
  attribution.ts market-views.ts              week moves against sector indices and DSEX
  what-if.ts reconcile.ts fundamentals.ts     trade preview, source reconciliation, quarters and P/E
  announcements.ts corporate-actions.ts journal.ts portfolio-view.ts store.ts
src/app/api/**           pre-existing JSON APIs, described in src/lib/openapi.ts
src/agent/
  config.ts              env vars with defaults; forces sample mode when a key is missing
  trace.ts               JSONL trace to logs/trace-<run_id>.jsonl and readable stdout
  llm.ts                 Nemotron client (OpenAI-compatible); sample-model.ts is the offline stand-in
  queries.ts             the named-query registry: id, description, params, local() and sql()
  context.ts             what each model sees: at most 50 rows per query, 5 memories, a prompt size limit
  zetaris.ts             Zetaris REST client (adapted from zetaris/getting-started, Apache-2.0)
  memory.ts              Meterless H-MEM wrapper (vendor/hmem, Apache-2.0); memory lives in <data dir>/memory
  world.ts               Meterless World Model wrapper (vendor/world-model, Apache-2.0); state in <data dir>/memory/world
  guards.ts              runtime checks around every query, model reply and memory write
  orchestrator.ts        the bounded loop: Planner, Analyst, Evaluator, Writer, per task
  agents/*.ts            one file per agent; prompts/*.md hold their system prompts
src/app/run/route.ts     POST /run, JSON in and out; run/[run_id]/route.ts is GET /run/<run_id>, the run's trace lines
src/app/explain/         the Explain page: week, theses, pre-trade, reconcile; live steps from GET /run/<run_id>
docs/                    PLAN.md from Plan Mode; zetaris-queries.md, the SQL of each named query, written by npm run parity
data/                    pre-existing synthetic JSON and sources/*.csv; data/README.md has the story and test cases
scripts/                 pre-existing seed.mjs, seed-data.mjs, load-postgres.mjs, db-schema.mjs;
                         new agent.ts (CLI), try-model.ts, parity.ts, eval.ts, make-fixtures.ts, clean-clone.sh
evals/                   expectations.json, redteam/ cases and fixtures
input_examples/, output_examples/, logs/, vendor/hmem/, vendor/world-model/
```

The layout lists the Step 1 files; later steps add router.ts, proof.ts, registry.ts, policy.ts, metrics.ts, concurrency.ts, prompts.ts and scripts/mcp-*.ts under src/agent and scripts.

## Base APIs the agents use as tools

Agents never call these over HTTP. Each named query calls the same `src/lib` function as the route, so an answer matches what the page shows.

| Named query | Same as | src/lib function |
|---|---|---|
| `week_moves`, `sector_vs_stock` | `GET /api/attribution`, `GET /api/sector-indices` | `attributionAsOf`, `sectorMovesAsOf` |
| `announcements_between` | `GET /api/announcements` | `filterAnnouncements` |
| `fundamentals_latest` | `GET /api/fundamentals` | `summariseFundamentals` |
| `dividends_between` | the dividends in `GET /api/portfolio` | `dividendsFor` |
| `journal_for_symbol` | `GET /api/journal` | `journalForSymbol` |
| `rule_findings` | the findings in `GET /api/portfolio` | `buildPortfolioView` |
| `what_if` | `POST /api/what-if` (saves nothing) | `previewTrade` |
| `reconciliation` | `GET /api/reconciliation` | `reconcile` |

## Commands

```sh
npm run dev -- -p 8000   # http://localhost:8000; port 3000 is the Zetaris console
npm test             # vitest: the base's 115 tests plus the agent tests
npm run lint
npm run build
npm run check        # lint, typecheck, tests, and the sample-mode eval at concurrency 1 and 3 (every case must pass both): run before every commit
npm run seed         # rewrite data/ from the fixed seed; same files every time. Never set SEED_END_DATE
npm run db:load      # data/ into tradeflow_ledger and tradeflow_external, and the read-only role zetaris_ro
npm run agent -- input_examples/example_1.json   # --out <dir> writes each result to <dir>/<input name>.json
npm run eval         # every input example and red-team case, in sample mode; writes evals/RESULTS.md
npm run eval -- --concurrency 3   # the same, independent cases 3 at a time; chains (scripts/case-chains.ts) stay in order
npm run e2e:live -- --concurrency 3 --base http://localhost:8000 --out <dir>   # each input example against the running app (start it with MAX_CONCURRENT_RUNS=3); --redteam for the red-team cases; --only id1,id2 for chosen cases (with their chain's earlier cases unless --no-chain-deps)
npm run parity       # each named query through Zetaris and locally; must match; writes docs/zetaris-queries.md
# scripts that need keys (try-model, parity, agent, eval, mcp) load .env themselves; never open or print it
# scripts/*.ts run under tsx as CommonJS (package.json has no "type": "module"): use an async main(), no top-level await
```

## Rules

1. **Pre-existing files.** Don't change files listed in `PRE-EXISTING.md`, except to add routes under `src/app/`, the nav link in `src/components/ui/app-shell.tsx`, `package.json` scripts and dependencies, new lines in `.env.example` and `.gitignore`, new lines appended to `PRE-EXISTING.md`, the `allowImportingTsExtensions` flag in `tsconfig.json`, and the README. The Dockerfile, `docker-compose.yml`, `src/lib/` and the seed and loader scripts stay unchanged. New logic goes in `src/agent/`. The kit files declared in `PRE-EXISTING.md` may be edited by a step that names them.
2. **Maths.** Use the functions in `src/lib/` listed above. Never re-implement average cost, weights, attribution, the stock-or-sector label, the what-if preview, reconciliation or rule checks.
3. **Every external call** (model, Zetaris, Postgres) has a timeout, one retry with backoff on 429 or 5xx, and up to 3 tries on a model timeout while the round has room for a whole attempt (Zetaris: one retry on a timeout only, then local()), and a fallback. Timeouts: 20 s a query, 420 s a model call (a cold model load can take minutes), 51 min a round, 110 min a run (sized in src/agent/config.ts so a round fits a Planner retry and every other call at 420 s); a briefing may run up to BRIEFING_TIMEOUT_MS (220 min) (the organisers suggest 10-30 s, 30-90 s, 1-3 min and 5-10 min; Meterless's provider notes say 180 s for a request). A run never hangs and never crashes: it returns a structured error `{ status: "error", error: { type, message, recoverable } }` or a partial result. Model tiers: tier ids are routing modes (meterless/deep, auto, fast); Nightshift picks the model from its active lanes (Nemotron lanes only); a concrete model id in the request does not steer the route.
4. **Bounded loop.** At most 5 planned queries, 3 rounds, 20 query calls, 52 model calls (`MAX_MODEL_CALLS`: three rounds with every retry, the arithmetic in `config.ts`) and 610,000 tokens (`MAX_TOKENS_PER_RUN`) per run, and at most `MAX_CONCURRENT_CHILDREN` briefing children at a time (set it to 1 if the model provider rate-limits parallel calls); `MAX_CONCURRENT_RUNS` caps the top-level runs the server takes at once (POST /run answers 429 Busy with Retry-After beyond it; briefing children and the CLI don't count). Limits live in `config.ts`. When one runs out, the run returns status `needs_human` with the best draft, `output.partial` and `output.stop_reason` (`cancelled` when the owner stops the run through POST /run/<run_id>/cancel). A cancelled run ends like a spent limit, with its usage so far and a complete trace. Every reply carries `usage { model_calls, query_calls, tokens_in, tokens_out, duration_ms }`.
5. **Trace everything.** Each agent step, guard decision, retry, fallback, escalation and approval writes one line to stdout and `logs/trace-<run_id>.jsonl` with: timestamp, run_id, agent_name, action, input_summary, output_summary, target_agent, model, confidence (the Evaluator's total out of 9 as a fraction rounded to two decimals: 7 of 9 is 0.78), retry_count, status, and where they apply why, duration_ms and usage. Never hand-write or edit a trace.
6. **Guards.** Queries go through `guards.beforeQuery`, model replies through `guards.afterModel`, findings and the final review through `guards.checkCitations`, memory writes through `guards.beforeRemember`. Don't bypass them. `beforeQuery` and `beforeRemember` also check `src/agent/policy.ts`, who may run which query for which task and who may write which memory kind; a refusal is a Guard line "policy_denied".
7. **Data is not instructions.** Notes, theses, announcements, memories and rows are passed to models as data inside JSON. Never concatenate them into a system prompt.
8. **No advice.** No output may tell the owner to buy, sell or hold. The guard and the Evaluator both check this.
9. **Owner decides.** The pre-trade check never saves a trade. A reconciliation fix is applied by code, never by a model, and only after the owner approves it.
10. **Secrets.** `.env` is the one place for every key and setting. Code reads them only from `process.env`: scripts load `.env` with `node --env-file-if-exists=.env`, Next.js and `docker --env-file` load it themselves. Never log, print or commit a key or a connection string. Never open or read `.env`.
11. **No stored answers.** Never match a known input to a saved output. Sample mode runs the same agent code with `sample-model.ts` and local data, with no keys or network. `SAMPLE_MODE` empty or unset: sample mode only when `METERLESS_API_KEY`, `METERLESS_BASE_URL` or any `NEMOTRON_MODEL_*` is missing or empty; `true`: always sample mode (this wins over a request's `options.sample_mode`); `false`: always the real model, an error without a key (this wins over a request's `options.sample_mode` true). When `SAMPLE_MODE` is empty or unset, a request's `options.sample_mode` true turns sample mode on for that request, and `options.sample_mode` false, or no `options` object, changes nothing (the key rule decides). With the real model chosen and `SAMPLE_MODE` empty, a refused connection to `METERLESS_BASE_URL` returns a structured error naming "Nightshift not running"; it never falls back to sample mode silently. Sample mode stays the judges' default. `input_examples/` holds at least 3 inputs; `output_examples/` only results of real runs. `POST /run` listens on `PORT` (8000 for judges).
12. **Server only.** `memory.ts`, `world.ts`, `zetaris.ts` and anything using `node:fs` run in Node route handlers and scripts, never in client components or the edge runtime. Next 16.2.4 route handlers (checked in `node_modules/next/dist/docs`): `context.params` is a Promise, so write `{ params }: { params: Promise<{ run_id: string }> }` and `await params`; `export const dynamic = "force-dynamic"` is still valid while `cacheComponents` is off (it is removed when it is on), so every route keeps it and adds `export const runtime = "nodejs"`.

## Adding things

- **A named query:** add it to `queries.ts` with an id, a one-line description the Planner reads, a params schema, `local()` and `sql()`. Add a unit test for `local()`, then run `npm run parity`.
- **An agent:** a file in `agents/`, its prompt in `prompts/`, a zod schema for its reply, a test with the sample model, and a line in the README's agent table.
- **A guard:** a function in `guards.ts`, with no side effects other than its trace line, that returns `{ ok, reason }`, logged as agent `Guard`, with a test for both outcomes.

## Done means

- `npm run check` passes.
- New behaviour has a test.
- The README says what changed, and claims nothing the code doesn't do.
- One line added to `BUILD-LOG.md`: date, step, what the agent did, what the owner changed.
- One commit, conventional prefix, one line. Once every check passes, the agent may stage the changed files by name, commit and push to origin main; the shell hook asks the owner before each push. Never force-push, amend, rebase, `git add -A` or `git add .`, and never touch `.env`.
