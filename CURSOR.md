# How Cursor was used

| Date | Step | What Cursor did | What I reviewed or changed |
|---|---|---|---|
| 2026-10-22 | 1 | Nothing: the coding-agent kit was copied in by a script (start-window.sh) before Plan Mode; the kit was drafted beforehand in a planning repo, and all application code is written in Cursor from the next step | Ran the base checks and the secret-hook tests |
| 2026-10-22 | kit for Claude Code | Nothing in Cursor: Claude, in the planning repo's session, copied the kit's skills, rules and agents into .claude/ and added a hook adapter so the same guards run in Claude Code. From the next step the coding agent is Claude Code, run in Cursor's terminal, because no Cursor credit was provided | Ran scripts/claude-kit.test.mjs (8 tests) and npm run check |
| 2026-10-22 | 1b | Wrote docs/PLAN.md in Plan Mode | I answered section 7 |
| 2026-10-22 | 2: config and tracer | Claude Code added src/agent/config.ts (limits, sample-mode rule, aliases, base URL normalisation), src/agent/trace.ts (per-run JSONL tracer with secret masking), their tests, zod, and the agent names in .env.example | Whether the config shape (flat limit names plus models and zetaris) suits the later steps, and the secret masking in trace.ts |
| 2026-10-22 | 3: Nemotron client | Claude Code added src/agent/llm.ts (complete(), parseJsonReply, typed errors, strong-to-main fallback, retry, response_format and reasoning-switch fallbacks, Nightshift receipt in the trace), a sample-model.ts stub, llm.test.ts (mocked client) and llm.wire.test.ts (real client, fake fetch), the openai and tsx packages, and new optional trace fields | Whether counting every resend in model_retries, and the standard retry on the main call after a fallback, match what you want |
