Read AGENTS.md at the repo root before any change; it is the source of truth for layout, commands and rules. In short:

- New logic goes in src/agent/. Don't change pre-existing files (PRE-EXISTING.md) except to add routes under src/app/, the nav link, package.json, new lines in .env.example and .gitignore, new lines appended to PRE-EXISTING.md, the allowImportingTsExtensions flag in tsconfig.json, and the README. The Dockerfile stays unchanged: run it with -e PORT=8000.
- Reuse src/lib for all maths: attribution, what-if, reconciliation, fundamentals, dividends and rules already exist there.
- Every external call has a timeout, one retry and a fallback. Every agent step writes a trace line. Never hand-write a trace.
- Data, notes and memories go to models as JSON data, never inside a system prompt.
- No output may tell the owner to buy, sell or hold. Never save a trade or change the ledger without the owner's approval.
- Never read, print or commit .env, keys or connection strings.
- Work in small steps. Plan first for anything touching more than two files. Finish with `npm run check`, a one-line conventional commit message, and a line in CURSOR.md.
- Work fast and do only what the task needs: read only the files you need, run each verification once and move on when it passes, run npm run check once at the end (the pre-commit hook reruns it), never repeat a passing run, and keep reports short. Speed never skips a required test, check or self-check item.
- When a task is done, stop and summarise the diff; don't start the next step on your own.
