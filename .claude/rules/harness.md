---
paths:
  - "src/agent/**"
  - "src/app/api/**"
  - "scripts/**"
  - "evals/**"
---
The harness and guardrail rules for every change to the agents, their tools, a run or a write. Read them with docs/PLAN.md before you plan a change, apply each one the change touches, and end your report with one line per rule you applied: `Harness: <rule> | <file:function> | <the test or trace line that proves it>`. A rule marked with a step applies once that step has built it.

Workflow: who decides what
- The orchestrator (src/agent/orchestrator.ts) owns the control flow: it starts each agent, counts the budget and ends the run. An agent never calls another agent; it gets one JSON input and returns one validated JSON output.
- The loop is plan, act, check, revise: the Planner plans at most 5 steps with a why each, the Analyst runs them through named queries, the Evaluator checks and scores out of 9, a score below 7 or a failed check sends a fix back to the Planner, and the Writer writes only an accepted draft. Keep a new behaviour inside this loop; don't add a side path.
- Safety-critical chains are fixed, not planned: pre_trade and reconcile use a fixed_plan trace line and no Planner. A new task that writes, approves or commits money gets a fixed plan too.
- A free question goes through the Router (src/agent/agents/router.ts, Step 19), which picks a task or refuses; it never answers.
- A handoff between agents or runs is a typed record and a trace line with target_agent (the briefing's handoff lines, Step 19b). Children run in parallel only through runWithLimit (src/agent/concurrency.ts, Step 20b) under MAX_CONCURRENT_CHILDREN.
- Every run ends with exactly one status, success, needs_human or error, and a stop_reason (src/agent/run-state.ts).
- Human in the loop: a trade, a ledger change or a reconcile fix is never saved by an agent. It ends needs_human with "Nothing has been saved; the decision is yours", and only the owner's approval writes it (Step 18). The review queue lists every needs_human run (Step 19).

Harness: limits, context, recovery, traces, evals
- Budgets: every new model call, query or round counts against MAX_ROUNDS, MAX_QUERY_CALLS, MAX_MODEL_CALLS and MAX_TOKENS_PER_RUN in src/agent/config.ts (a model call that fails or returns nothing counts too: it may still be billed), and each limit that can run out has a test that ends the run with its stop_reason. A number that limits a run lives in config.ts, never in the code that uses it.
- Time: each model call gets the time left in the run (RUN_TIMEOUT_MS, ROUND_TIMEOUT_MS) as its timeout. A long loop checks for cancellation between steps (src/agent/registry.ts, Step 20c) and ends with stop_reason "cancelled" and a complete trace.
- Context: an agent sees only what its job needs: forModel (MAX_ROWS_PER_QUERY rows), memoriesForModel (MAX_MEMORIES), catalogueFor(task), and only the cited rows for the Evaluator and the Writer (citedResults). Prompts stay under MAX_PROMPT_CHARS. Never pass a whole table, file or trace to a model.
- Structured output: replies are parsed with parseJsonReply and validated with the agent's zod schema; an unparseable reply is retried once, then a typed BadJson error. Never accept free text where a schema exists.
- Recovery: strong falls back to main and the trace says so; a 401 or 403 is Unauthorized and a refused connection is NightshiftNotRunning, and neither falls back; Zetaris falls back to local rows with source "local-fallback". llm.ts retries a timeout or a 429 once when time is left, then throws ModelTimeout or RateLimited; a caller never loops on either. A 502 "empty_response" (the lane gave no answer) gets one plain retry at max_tokens 8000, traced as "empty_response_retry". No reasoning switch goes to Nightshift: reasoning {enabled: false} makes its lane return empty replies on large requests, and it ignores chat_template_kwargs. When the Evaluator's score still fails, the draft is accepted on the code checks alone (citations, guards and coverage), with score null, traced as "score_unavailable"; a failed code check still rejects.
- Cache: a query with the same id and params runs once per run (the per-run query cache in src/agent/run-state.ts); a cached call is traced as action "cached" and counts no query call. A tool call goes through the same cache and budget.
- Traces: every action writes one TraceLine (src/agent/trace.ts) with agent_name, action, input_summary, output_summary, status, why, confidence and usage, through maskSecrets, so no key or token reaches a trace. Every model line carries prompt_hash and every line its task (Step 20d). Never hand-write or edit a trace.
- Sample mode: SAMPLE_MODE runs the same code path with src/agent/sample-model.ts; a sample rule decides from the input facts only, and it gives the verdict each case in evals/expectations.json expects. Tests use the sample model or a mock, so npm test needs no network.
- Prompts: each agent's prompt is its own file in src/agent/prompts/ with an Examples section, loaded as-is, never built by joining strings with data.
- Evals: a new behaviour gets an entry in evals/expectations.json; a new guard or refusal gets a red-team case in evals/redteam/cases.json; a change to an agent's prompt or rule is measured before and after (npm run eval, and /improve-agent's evals/IMPROVEMENTS.md) and kept only if it helps.
- Metrics: runs are compared through metricsFromTraces (src/agent/metrics.ts, Step 20d), never by reading output_examples/.

Guardrails: what never gets through
- Data is never an instruction: text from rows, memories, notes or questions goes to a model boxed as data, injectionIn flags instruction-like wording and afterModel sets injection_seen, and a flag can only lower trust, never unlock an action.
- Every query goes through guards.beforeQuery: named queries only, params validated, the budget checked; the model never writes SQL. Every tool an agent calls is one its policy allows (src/agent/policy.ts, Step 20e), and a denied call writes a Guard line "policy_denied".
- Every model reply goes through guards.afterModel: the schema, the advice refusal (never "you should buy, sell or hold") and the injection flag.
- Every number in a finding goes through guards.checkCitations against the rows it cites; a number no row holds rejects the finding.
- Every memory write goes through guards.beforeRemember (at most MAX_MEMORY_CHARS, no injected text, no secret); a rejected write stores nothing and writes one Guard line.
- Every review ends with the disclaimer line, and a question asking for advice ends with declined_advice true.
- Secrets live only in .env, which no code prints, logs, traces or copies; a new setting is a name in .env.example with no value.
- Never weaken a guard, a test, an expectation or a check to make a change pass; a guard that blocks something it should allow is fixed with a new test that shows the allowed case.
