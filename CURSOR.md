# How Cursor was used

| Date | Step | What Cursor did | What I reviewed or changed |
|---|---|---|---|
| 2026-10-22 | 1 | Nothing: the coding-agent kit was copied in by a script (start-window.sh) before Plan Mode; the kit was drafted beforehand in a planning repo, and all application code is written in Cursor from the next step | Ran the base checks and the secret-hook tests |
| 2026-10-22 | kit for Claude Code | Nothing in Cursor: Claude, in the planning repo's session, copied the kit's skills, rules and agents into .claude/ and added a hook adapter so the same guards run in Claude Code. From the next step the coding agent is Claude Code, run in Cursor's terminal, because no Cursor credit was provided | Ran scripts/claude-kit.test.mjs (8 tests) and npm run check |
