# Pre-existing work

Everything in this repository at the git tag `pre-hackathon` existed before the Open Agent Hackathon 2026 build window opened on 15 October 2026 (00:00 UTC). It is declared here as pre-existing work for the Wildcard [Tinkerer] track. Only commits after that tag are hackathon work.

## What the base project is

Tradeflow is a small stock portfolio ledger on synthetic data: transactions, holdings, profit and loss, a week-over-week view, and a set of rules the owner checks the portfolio against. See `README.md`.

## Pre-existing components

| Component | Where | Origin |
|---|---|---|
| Ledger maths: holdings, average cost, break-even, realized and unrealized P/L | `src/lib/portfolio.ts` and its test | Copied unchanged from the owner's private portfolio app |
| Commission rule (0.4% each way) | `src/lib/fees/trade-commission.ts` | Same |
| Number formatting and Dhaka time | `src/lib/format-bdt.ts`, `src/lib/format-dhaka-time.ts` | Same |
| DSE trading calendar (Sunday to Thursday) | `src/lib/market/trading-calendar.ts` and its test | Same |
| Sector label helpers | `src/lib/sector-targets.ts` | Same |
| JSON data store, quotes from daily bars, rules checks, portfolio view | `src/lib/store.ts`, `src/lib/data.ts`, `src/lib/transactions.ts`, `src/lib/market/quotes.ts`, `src/lib/rules.ts`, `src/lib/portfolio-view.ts` | Written for this public version, before the build window |
| Pages, forms and JSON API | `src/app/**`, `src/components/**` | Same |
| Synthetic data and its generator | `data/*.json`, `scripts/seed.mjs` | Same |
| Synthetic data and its generator, regenerated: 190 sessions to a fixed end date (1 Oct 2026), 15 symbols, 45 trades, and a planted week-by-week story and test cases | `data/**`, `data/README.md`, `scripts/seed.mjs`, `scripts/seed-data.mjs`, `src/test/story.data.test.ts` | Regenerated 5 Oct 2026, before the build window |
| Company announcements (synthetic): loader, filters, page and API | `src/lib/announcements.ts`, `src/app/announcements/`, `src/app/api/announcements/` | Written 5 Oct 2026 for this public version, before the build window |
| Cash dividends and bonus shares: entitlement on the record date, zero-cost bonus rows, dividend income | `src/lib/corporate-actions.ts`, `src/app/history/` | Written 5 Oct 2026 for this public version, before the build window |
| Broker statement and bank deposit files, CSV parser and loaders, read-only page | `data/sources/*.csv`, `src/lib/sources.ts`, `src/app/sources/` | Written 5 Oct 2026 for this public version, before the build window |
| DSEX index and sector indices | `src/lib/market/index.ts`, `src/lib/market/sector-index.ts`, `src/app/sector-indices/`, `src/app/api/sector-indices/` | Written 5 Oct 2026 for this public version, before the build window |
| Trade journal: entries, form fields on the Transactions page, page and API | `src/lib/journal.ts`, `src/app/journal/`, `src/app/api/journal/`, `src/app/transactions/` | Written 5 Oct 2026 for this public version, before the build window |
| As-of views: the portfolio built for any past session, as-of APIs and date pickers | `src/lib/portfolio-view.ts` (rewritten as a pure builder), `src/lib/http.ts`, `src/app/api/portfolio/`, `src/app/api/transactions/` | Written 5 Oct 2026 for this public version, before the build window |
| Performance attribution against sector indices and DSEX | `src/lib/attribution.ts`, `src/lib/market-views.ts`, `src/app/api/attribution/` | Written 5 Oct 2026 for this public version, before the build window |
| Trade preview (what-if) before saving a trade | `src/lib/what-if.ts`, `src/app/api/what-if/`, the Preview button in `src/app/transactions/view.tsx` | Written 5 Oct 2026 for this public version, before the build window |
| Deterministic reconciliation of the sources against the ledger | `src/lib/reconcile.ts`, `src/app/reconciliation/`, `src/app/api/reconciliation/` | Written 5 Oct 2026 for this public version, before the build window |
| Company fundamentals (synthetic) and the instrument pages | `src/lib/fundamentals.ts`, `src/lib/instrument-view.ts`, `src/app/instruments/`, `src/app/api/fundamentals/` | Written 5 Oct 2026 for this public version, before the build window |
| Owner profile and preferences | `src/lib/profile.ts`, `src/app/settings/`, `src/app/api/profile/` | Written 5 Oct 2026 for this public version, before the build window |
| Health check and OpenAPI description | `src/lib/health.ts`, `src/lib/openapi.ts`, `src/app/api/health/`, `src/app/api/openapi.json/` | Written 5 Oct 2026 for this public version, before the build window |
| User interface rebuilt with Ant Design 6, Source Sans 3 and Source Serif 4; Tailwind removed | `src/app/layout.tsx`, `src/app/**/view.tsx`, `src/components/**`, `src/app/globals.css` | Written 5 Oct 2026 for this public version, before the build window |
| Postgres loader and its schema, docker-compose for Postgres, Dockerfile | `scripts/load-postgres.mjs`, `scripts/db-schema.mjs`, `docker-compose.yml`, `Dockerfile`, `.dockerignore`, `.env.example` | Written 5 Oct 2026 for this public version, before the build window |

None of the components above calls a language model or contains AI, agent or prompt code. That is built in the hackathon window.

## How to see the before and after

```sh
git diff pre-hackathon --stat      # files the hackathon touched
git log pre-hackathon..HEAD        # hackathon commits only
```
