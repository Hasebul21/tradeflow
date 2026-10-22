---
name: improve-agent
description: Improve the runtime agents one measured change at a time, driven by eval failures and traces.
disable-model-invocation: true
---
Use when the owner types /improve-agent, optionally followed by a case id (such as example_1) or an agent name. One change per run. Never open or print .env; scripts load it.

1. Baseline. Run npm run eval -- --no-results (sample mode), then SAMPLE_MODE=false npm run eval -- --no-results twice (the real model; replies vary, so two runs). Note for each case: pass or fail, rounds, the Evaluator total and model calls. A 429 is a rate limit, not a failure: wait a minute and rerun that run once.
2. Pick one weakness: the case the owner named; else a case that failed in either real-model run; else the case with the most rounds or the lowest total. Read its trace with cat logs/trace-<case>.jsonl in the terminal, and name the agent and the line where it went wrong (for example: the Analyst wrote "because of"; the Planner missed sector_vs_stock; the Writer added a number the findings don't have).
3. Make exactly one change, the smallest that addresses it, in one file: a rule or one more worked example in a system prompt in src/agent/prompts/ (examples use the made-up holding ACMEPHARMA, never real Tradeflow figures), a query description in src/agent/queries.ts, a sample-model rule in src/agent/sample-model.ts, or a context limit in src/agent/context.ts. Never change evals/expectations.json, evals/redteam/cases.json, a guard, or a test to make a case pass.
4. Rerun exactly the baseline commands. Keep the change only if no case that passed now fails, in sample mode and in both real-model runs, and the chosen case improved (it passes, or needs fewer rounds, or scores higher). Otherwise undo it with git restore <that one file>.
5. Append one row to evals/IMPROVEMENTS.md (create it with a header row if missing): date, case, agent, the change in one line, before and after (passes, rounds, total), kept or reverted.
6. Run npm run check. Stage by name and commit: a kept change with its file and evals/IMPROVEMENTS.md as "fix(agent): <the change in a few words>"; a reverted one as evals/IMPROVEMENTS.md alone, "docs: log a reverted agent change". Then git push origin main; the shell hook asks the owner. Never git add -A or git add ., never force-push, amend or use --no-verify.
7. Stop. Report the baseline and the after numbers as a small table, the change, kept or reverted, the commit hash, and the next weakness you would pick. Don't make a second change.
