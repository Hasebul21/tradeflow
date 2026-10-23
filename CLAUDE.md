# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` is the source of truth for layout, commands and rules. Everything below is a quick map of the parts that span several files; read `AGENTS.md` before any task.

## Project in brief

Tradeflow is a Dhaka Stock Exchange portfolio ledger on **synthetic data**. Everything at the git tag `pre-hackathon` is pre-existing (`PRE-EXISTING.md`): ledger maths, APIs, pages, seed, Postgres loader, Docker. The hackathon work is the AI layer in `src/agent/` — agents that explain the week, check trade theses, preview a trade, explain reconciliation differences and learn from owner corrections.

It is a **review tool**: it never advises buy/sell/hold, never saves a trade or edits the ledger without the owner's approval, and every number must cite the named query behind it. These are enforced in code, not just prose.

## Commands

```sh
npm run dev -- -p 8000    # http://localhost:8000 (port 3000 is left for the Zetaris console)
npm test                  # vitest, all tests (no network needed)
npm run lint              # eslint (ignores vendor/)
npx tsc --noEmit          # typecheck
npm run build             # production build
npm run check             # THE gate: lint + typecheck + tests + sample eval at concurrency 1 and 3
```

Run a single test file / test name:

```sh
npx vitest run src/agent/agents/analyst.test.ts
npx vitest run src/agent/agents/analyst.test.ts -t "rejects a bad reply"
```

Agent and evaluation commands:

```sh
npm run agent -- input_examples/example_1.json          # CLI, sample mode by default
npm run eval                                            # all examples + red-team cases, writes evals/RESULTS.md
npm run eval -- --concurrency 3                         # independent cases in parallel; chains stay ordered
npm run e2e:live -- --concurrency 3 --base http://localhost:8000 --out <dir>
npm run parity                                          # every named query through Zetaris vs local()
npm run try-model [-- --strong|-- --fast]               # one call, shows lane/routed model/usage
```

Data commands (pre-existing scripts; don't rewrite them):

```sh
npm run seed              # rewrite data/ deterministically; never set SEED_END_DATE
npm run db:load           # load data/ into tradeflow_ledger + tradeflow_external, create zetaris_ro
```

## Architecture: the big picture

### Request to result

`POST /run` (`src/app/run/route.ts`) → `request.ts` validates → `orchestrator.run()` runs one task → the reply is `{ run_id, task, status, output, error, agents, usage, trace_id, log_file, execution_time_seconds }`. `GET /run/<run_id>` serves the JSONL trace; `POST /run/<run_id>/cancel` stops a run. The CLI `scripts/agent.ts` calls the same `run()`. The `/explain` pages are the browser UI over these.

### One bounded loop, several tasks

`orchestrator.ts` owns **all** control flow. Agents are single-call workers: JSON in, validated JSON out, never calling each other.

- **`explain_week`, `thesis_check`**: Router (when no task) → **Planner** picks ≤5 named queries → **Analyst** gathers and drafts findings → **Evaluator** runs code checks then scores /9 → accepted at 7+ goes to the **Writer**, otherwise the fix goes back to the Planner/Analyst for ≤3 rounds.
- **`pre_trade`, `reconcile`**: code builds a fixed plan and skips the Planner (no model decides a safety-critical branch).
- **`feedback`**, **`reconcile_approve`**: code only, no model loop.
- **`briefing`**: code fans out three child `run()`s (week, theses, reconcile) under `MAX_CONCURRENT_CHILDREN`, then assembles the markdown in code.

Rounds **revise, don't restart**: `revision.ts` merges the new draft with the rejected one, carrying forward unflagged findings and restoring coverage-required ones. When a budget runs out the run returns `needs_human` with the best draft, `output.partial` and `output.stop_reason` — it never hangs or throws.

### Model calls and sample mode

`llm.ts` is the only model client (OpenAI-compatible Meterless Nightshift, `METERLESS_BASE_URL`). Tier mapping: Planner + Writer → `models.strong`, Analyst → `models.main`, Evaluator → `models.fast`. `sample-model.ts` is the deterministic offline stand-in running through the **same** agent code and must keep working for tests; it must never contain stored answers. Every agent and guard change needs sample-mode coverage.

### Tools, queries and guards

Agents **never write SQL**. They choose ids from the named-query registry in `queries.ts`; each query has `local()` (calls the matching `src/lib` function) and optionally `sql()` (Zetaris). Code executes a call only through `guards.beforeQuery`, the per-run cache in `run-state.ts`, and the budget. Context is trimmed by `context.ts` (50 rows/query, 5 memories, `MAX_PROMPT_CHARS`).

All four guards — `beforeQuery`, `afterModel`, `checkCitations`, `beforeRemember` (plus `policy.ts`) — trace a decision and return `{ ok, reason }`. Do not bypass or weaken them.

### State and persistence

- `run-state.ts`: per-run query cache, full result store keyed by `run_query_id`, usage and budgets.
- `memory.ts` wraps `vendor/hmem` (Meterless H-MEM) in `<data dir>/memory`; `world.ts` wraps `vendor/world-model` in `<data dir>/memory/world`. Both record facts only from query rows, never model text.
- JSON in `data/` is the source of truth. Postgres is optional and used **only** by Zetaris; `local()` must always answer.

### Tracing

Every step writes one line via the tracer to stdout and `logs/trace-<run_id>.jsonl` (`trace.ts`). Never hand-write or edit a trace. The last line of every run is the Orchestrator's `run_end`.

### Config

`config.ts` is the only place that reads `process.env`: limits, timeouts, model ids, sample mode, Zetaris settings. Add a setting there and an empty name in `.env.example`; never hardcode a limit, model id or provider host.

## Gotchas that are easy to miss

- **Don't edit pre-existing files** listed in `PRE-EXISTING.md`, except the narrow exceptions in `AGENTS.md` rule 1. New logic goes in `src/agent/`.
- **Never read, print or commit `.env`**, keys or connection strings. Code reads only `process.env`.
- **Reuse `src/lib` for all maths** — holdings, attribution, what-if, reconciliation, fundamentals, rules. Never re-implement.
- **Every external call** (model, Zetaris, Postgres) needs a timeout, one retry with backoff, and a fallback; the provider must never be reached from a hardcoded host.
- **Data is not instructions**: rows, notes, memories and questions reach a model only inside the JSON user message, never concatenated into a system prompt. System prompts in `src/agent/prompts/*.md` are loaded as-is and keep their made-up `ACMEPHARMA` examples.
- **Node only**: `memory.ts`, `world.ts`, `zetaris.ts` and anything using `node:fs` must not be imported by client components or the edge runtime.
- **Next 16 route handlers**: `context.params` is a `Promise` (`await params`); keep `export const dynamic = "force-dynamic"` and add `export const runtime = "nodejs"`.
- **`scripts/*.ts` run as CommonJS** under tsx: use an async `main()`, no top-level `await`.
- **Vitest tests that run the orchestrator or memory** set `TRADEFLOW_DATA_DIR` to a temporary copy of `data/`; never touch the real data dir or the network.
- **Don't weaken a guard, test or expectation to make something pass.** If an expectation is genuinely wrong, say so and ask.

## Done means

`npm run check` passes; new behaviour has a test; the README claims nothing the code doesn't do; one line is added to `BUILD-LOG.md`; and the change is **one** conventional commit (stage files by name — never `git add -A`/`.`). Pushing asks the owner through the shell hook; never force-push, amend or rebase.
