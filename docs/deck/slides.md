---
marp: true
theme: default
paginate: true
size: 16:9
footer: Synthetic data
style: |
  section { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 30px; padding: 34px 52px 50px; background: #eef1f5; color: #16202e; }
  section.lead { justify-content: center; }
  section.lead h1 { font-size: 66px; color: #16202e; }
  h2 { font-size: 46px; margin: 0 0 8px; color: #16202e; }
  p { margin: 6px 0; }
  footer, section::after { font-size: 18px; color: #566173; }
  .diagram, .cards { display: grid; gap: 10px 0; align-items: center; margin-top: 14px; font-size: 22px; line-height: 1.2; }
  .box { background: #fff; border: 3px solid #16202e; border-radius: 14px; padding: 8px 12px; text-align: center; font-size: 23px; line-height: 1.2; min-height: 60px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
  .box.sp { border-color: #b86e00; background: #fbefd6; }
  .box.ok { border-color: #1d6b45; background: #dff1e7; }
  .box.no { border-color: #b42318; background: #fbe4e1; }
  .sql { font-family: Menlo, monospace; font-size: 22px; text-align: left; display: block; }
  .sql code { display: block; margin-top: 6px; color: #34508a; font-size: 22px; }
  .arrow { position: relative; text-align: center; font-size: 22px; font-weight: 700; color: #b86e00; padding-bottom: 16px; }
  .arrow::after { content: ""; position: absolute; left: 0; right: 10px; bottom: 5px; height: 3px; background: #b86e00; }
  .arrow::before { content: ""; position: absolute; right: 0; bottom: -2px; border-left: 14px solid #b86e00; border-top: 8px solid transparent; border-bottom: 8px solid transparent; }
  .arrow.v { display: flex; align-items: center; justify-content: flex-start; padding: 0 0 0 calc(50% + 14px); min-height: 44px; }
  .arrow.v::after { left: 50%; right: auto; width: 3px; height: auto; top: 0; bottom: 10px; }
  .arrow.v::before { left: calc(50% - 6px); right: auto; bottom: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 14px solid #b86e00; border-bottom: 0; }
  .arrow.u::before { bottom: auto; top: 0; border-top: 0; border-bottom: 14px solid #b86e00; }
  .flow { display: flex; align-items: center; justify-content: center; }
  .flow .box { width: 220px; flex: none; }
  .flow .arrow { width: 70px; flex: none; padding-bottom: 12px; }
  .loop { position: relative; margin: 0 0 0 110px; width: 580px; height: 60px; border: 3px solid #b86e00; border-top: 0; border-radius: 0 0 14px 14px; text-align: center; color: #b86e00; font-weight: 700; font-size: 22px; padding-top: 14px; box-sizing: border-box; }
  .loop::before { content: ""; position: absolute; left: -10px; top: -14px; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 14px solid #b86e00; }
  .seq { grid-template-columns: repeat(4, 124px 32px); }
  .seq .box { min-height: 100px; padding: 6px 4px; font-size: 22px; }
  .strip { background: #dff1e7; border: 3px solid #1d6b45; border-radius: 14px; padding: 8px 14px; font-size: 24px; line-height: 1.25; text-align: left; box-sizing: border-box; }
  .stat { font-size: 24px; font-weight: 700; margin: 6px 0 0; }
  .guard { background: #fbefd6; border: 3px solid #b86e00; border-radius: 10px; padding: 6px 8px; text-align: center; font-size: 22px; line-height: 1.15; }
  .cards.three { grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .cards .box { flex-direction: column; min-height: 90px; }
  .cards .box b { color: #b86e00; font-size: 26px; display: inline-block; margin-right: 12px; }
  .chain .box { position: relative; }
  .chain .box.n::after { content: ""; position: absolute; right: -34px; top: 50%; width: 24px; height: 3px; background: #b86e00; }
  .chain .box.n::before { content: ""; position: absolute; right: -36px; top: calc(50% - 7px); border-left: 12px solid #b86e00; border-top: 8px solid transparent; border-bottom: 8px solid transparent; }
  .cards.row { gap: 12px; }
  ul.p { list-style: none; padding: 0; margin: 0; font-size: 26px; }
  ul.p li { margin: 4px 0; }
---

<!-- _class: lead -->
<!-- _paginate: false -->

# Tradeflow review agents

Review a Dhaka Stock Exchange portfolio and cite the query behind every number.

Hasebul

Wildcard [Tinkerer]

https://github.com/Hasebul21/tradeflow

<!-- Sources: the title, name, track and link come from README.md and metadata.json (project.name, track, repository). No numbers on this slide. The data is synthetic (data/README.md); the footer says so on every slide. -->

---

## The problem

A Dhaka Stock Exchange investor sees the move, not the reason, and never rechecks why they bought.

![bg right:34% fit](base.png)

<div class="cards" style="grid-template-columns: 1fr 50px 1fr; width: 100%;">
<div class="box no">Down 1.67% this week. No reason.</div>
<div class="arrow"></div>
<div class="box ok">BXPHARMA fell 14.88%, its own move. Every number cites its query.</div>
</div>

<div class="cards"><div class="box sp">An AI answer you cannot check is not worth acting on.</div></div>

<!-- Sources: 1.67% and 14.88% come from the fresh real-model run deck-1: reply output.summary (its summary says "Your portfolio fell 1.67% in the week to 01 Oct ... BXPHARMA's 14.88% fall") and logs/trace-deck-1.jsonl. The picture on the right is base.png, the pre-existing portfolio page (localhost:8000/) with the same -1.7% week and no reason. Pre-existing means the tag pre-hackathon (PRE-EXISTING.md). -->

---

## What it does

![bg right:36% fit](explain.png)

<div class="cards" style="grid-template-columns: 1fr; gap: 10px;">
<div class="box" style="min-height: 84px; display: block; text-align: left; padding-top: 16px;"><b>Explain my week</b> Why it moved. BXPHARMA fell 14.88%</div>
<div class="box" style="min-height: 84px; display: block; text-align: left; padding-top: 16px;"><b>Thesis check</b> Does the reason hold? BXPHARMA: contradicted</div>
<div class="box" style="min-height: 84px; display: block; text-align: left; padding-top: 16px;"><b>Pre-trade check</b> Rules, before saving. WALTONHIL: Engineering target broken</div>
<div class="box sp" style="min-height: 84px;">Before 22 Oct (tag pre-hackathon): the ledger, no reasons. Built in the window: the review agents.</div>
</div>

<!-- Sources: Explain my week, BXPHARMA fell 14.88%: fresh run deck-1 (logs/trace-deck-1.jsonl, reply output.summary). Thesis check, BXPHARMA contradicted: output_examples/example_5.json, output.verdicts, journal_id j-013 verdict contradicted (a real-model run). Pre-trade check, WALTONHIL breaks the Engineering target: fresh run deck-6a, output.escalation (rule sector_target, sector Engineering, before 0, after 11.88, target 5) and output_examples/example_6a.json. The strip: PRE-EXISTING.md and the git tag pre-hackathon. explain.png is localhost:8000/explain. -->

---

## The whole system

<div class="diagram" style="grid-template-columns: 230px 90px 310px 140px 1fr;">
<div class="box" style="grid-row: 1 / 4; grid-column: 1;">Owner: Explain page, POST /run, npm run agent</div>
<div class="arrow" style="grid-row: 2; grid-column: 2;">request</div>
<div class="box" style="grid-row: 1 / 4; grid-column: 3; min-height: 330px;">orchestrator.ts: Planner, Analyst, Evaluator, Writer</div>
<div class="arrow" style="grid-row: 1; grid-column: 4;">queries</div>
<div class="box sp" style="grid-row: 1; grid-column: 5;">Zetaris (zetaris.ts): ledger and external Postgres</div>
<div class="arrow" style="grid-row: 2; grid-column: 4;">memory</div>
<div class="box sp" style="grid-row: 2; grid-column: 5;">Meterless H-MEM (memory.ts), World Model (world.ts)</div>
<div class="arrow" style="grid-row: 3; grid-column: 4;">deep, auto, fast</div>
<div class="box sp" style="grid-row: 3; grid-column: 5;">NVIDIA Nemotron via Meterless Nightshift (llm.ts)</div>
<div class="arrow v" style="grid-row: 4; grid-column: 3;">trace</div>
<div class="box" style="grid-row: 5; grid-column: 3;">logs/trace-RUN.jsonl</div>
</div>

<!-- Sources: src/agent/orchestrator.ts (the loop), src/agent/agents/planner.ts, analyst.ts, evaluator.ts, writer.ts; src/agent/zetaris.ts; src/agent/memory.ts (H-MEM, vendor/hmem); src/agent/world.ts (World Model, vendor/world-model); src/agent/llm.ts (Nemotron through Meterless Nightshift, METERLESS_BASE_URL); src/agent/trace.ts (logs/trace-RUN_ID.jsonl); src/app/explain, src/app/run/route.ts, scripts/agent.ts (npm run agent). The tiers deep, auto and fast are the requested_model values meterless/deep (Planner, Writer), meterless/auto (Analyst) and meterless/fast (Evaluator) in the model_call lines of output_examples/traces/. evals/RESULTS.md names the lane: routed_model openrouter/nvidia/nemotron-3.5-lightning, 49 of the 51 model_call lines that carry routed_model and cost_usd in output_examples/traces/ (the other 2 routed to nemotron-3-ultra-550b-a55b:free). -->

---

## The agent loop

<div class="diagram" style="grid-template-columns: 1fr;">
<div class="flow">
<div class="box">Planner: up to 5 queries</div><div class="arrow"></div>
<div class="box">Analyst: drafts findings</div><div class="arrow"></div>
<div class="box">Evaluator: scores out of 9</div><div class="arrow"></div>
<div class="box ok">Writer: accepted drafts only</div>
</div>
<div class="loop">score below 7 of 9 or a failed check</div>
<div class="flow">
<div class="box" style="width: 620px;">Limits: 3 rounds, 20 queries, 54 model calls, 630,000 tokens, 110 minutes</div><div class="arrow" style="width: 150px;">spent</div>
<div class="box no" style="width: 320px;">needs_human: owner takes over</div>
</div>
</div>

<!-- Sources: src/agent/config.ts, limitsSchema defaults: MAX_ROUNDS 3 (MAX_ROUNDS_DEFAULT), MAX_QUERY_CALLS 20, MAX_MODEL_CALLS 54 (MAX_MODEL_CALLS_DEFAULT, the arithmetic is in config.ts), MAX_TOKENS_PER_RUN 630,000, RUN_TIMEOUT_MS 110 minutes (6,600,000 ms, also in the run_start line of logs/trace-deck-1.jsonl). Planner picks at most MAX_PLAN_STEPS 5. Evaluator accepts at 7 of 9 or more (PASS_TOTAL = 7 at src/agent/agents/evaluator.ts line 32); the Writer writes only an accepted draft; a spent limit ends needs_human with output.partial and stop_reason (AGENTS.md rule 4). The brief said 12 model calls; the code says 54, so the slide shows 54. -->

---

## One real run

![bg right:40% fit](trace.png)

<div class="diagram seq" style="width: 100%;">
<div class="box">Question</div><div class="arrow"></div>
<div class="box">Memory: none</div><div class="arrow"></div>
<div class="box">5 queries, each with a why</div><div class="arrow"></div>
<div class="box">Draft: 16 findings</div><div></div>
<div class="box ok">Score 9 of 9</div><div class="arrow"></div>
<div class="box no">Disclaimer check failed</div><div class="arrow"></div>
<div class="box">Code added the line</div><div class="arrow"></div>
<div class="box ok">Review written, memory saved</div><div></div>
<p class="stat" style="grid-column: 1 / -1;">1 round, 4 model calls, 41,382 tokens, 199 seconds</p>
</div>

<!-- Sources: numbers and screenshot are from the same run. Run id deck-1, task explain_week, as_of 2026-10-01, a fresh data copy with no memory, the real model. All numbers are from logs/trace-deck-1.jsonl (read through GET /run/deck-1) and its reply: run_end line status=success rounds=1 findings=16 citations=3; Planner plan line "5 steps: week_moves, sector_vs_stock, announcements_between, dividends_between, rule_findings"; Memory recall line by_tag=none; Analyst analyse line "16 findings"; three Evaluator code_check lines passed; Evaluator accept line accuracy=3 appropriateness=3 actionability=3 total=9 of 9; Writer code_check rejected "the last line of review_markdown must be the disclaimer"; Writer disclaimer_added (code puts the fixed sentence last); Memory remember memoryId=mem-52. Usage in the reply: model_calls 4, tokens_in 31,282 plus tokens_out 10,100 = 41,382, duration_ms 199,139 (199 seconds). The nine steps are joined to eight boxes: the review written and the memory saved are one box. The Evaluator accepted the first draft, so the only rejection in this run is the Writer's own disclaimer check. trace.png is localhost:8000/explain/runs/deck-1. -->

---

## The data layer

<div class="diagram" style="grid-template-columns: 1fr 1fr; gap: 0 36px; align-items: start;">
<div style="display: grid; grid-template-columns: 1fr 120px 1fr; gap: 6px 0; align-items: center;">
<div class="box">Named queries: 8 with sql()</div>
<div class="arrow" style="grid-row: 1; grid-column: 2;">fallback</div>
<div class="box" style="grid-row: 1; grid-column: 3;">local(): src/lib</div>
<div class="arrow v" style="grid-row: 2; grid-column: 1;">sql()</div>
<div class="box sp" style="grid-row: 3; grid-column: 1 / 4;">Zetaris</div>
<div class="arrow v" style="grid-row: 4; grid-column: 1;"></div>
<div class="arrow v" style="grid-row: 4; grid-column: 3;"></div>
<div class="box" style="grid-row: 5; grid-column: 1;">tradeflow_ledger</div>
<div class="box" style="grid-row: 5; grid-column: 3;">tradeflow_external</div>
</div>
<div style="display: grid; gap: 10px;">
<div class="box sql">SELECT symbol, from_close, to_close, ROUND((to_close - from_close) / from_close * 100, 2)…<code>docs/zetaris-queries.md</code></div>
<div class="box ok">parity: match, 8 of 8</div>
<div class="box sp">reconciliation: one SQL join across both databases</div>
</div>
</div>

<!-- Sources: src/agent/queries.ts (the registry has 9 named queries; 8 have sql(): week_moves, sector_vs_stock, announcements_between, fundamentals_latest, dividends_between, journal_for_symbol, rule_findings, reconciliation; what_if is local only), src/agent/zetaris.ts (REST client; falls back to local() with source local-fallback), docs/zetaris-queries.md (the SQL box is the start of the week_moves statement; every one of its 8 sections ends "parity: match", written by npm run parity on 2026-10-23). The reconciliation statement in that file joins tradeflow_external.broker_statement and bank_deposits with tradeflow_ledger.transactions and contributions (FULL OUTER JOIN). In the fresh run deck-1, the 5 query lines say source=zetaris (logs/trace-deck-1.jsonl). -->

---

## Memory across two weeks

<div class="diagram" style="grid-template-columns: 1fr 100px 1.1fr 100px 1fr;">
<div style="grid-row: 1; grid-column: 1; font-weight: 700;">Week one</div>
<div style="grid-row: 1; grid-column: 5; font-weight: 700;">Week two</div>
<div class="box" style="grid-row: 2; grid-column: 1;">Review saved to H-MEM</div>
<div class="arrow" style="grid-row: 2; grid-column: 2;"></div>
<div class="box sp" style="grid-row: 2 / 4; grid-column: 3;">World Model facts, each with run_query_id</div>
<div class="arrow" style="grid-row: 2; grid-column: 4;">recalled</div>
<div class="box" style="grid-row: 2; grid-column: 5;">Review recalled by tag</div>
<div class="box" style="grid-row: 3; grid-column: 1;">Owner's correction mined</div>
<div class="arrow" style="grid-row: 3; grid-column: 2;"></div>
<div class="arrow" style="grid-row: 3; grid-column: 4;"></div>
<div class="box" style="grid-row: 3; grid-column: 5;">Correction recalled and applied</div>
<div class="box ok" style="grid-row: 4; grid-column: 1 / 6; font-style: italic;">"Week to 2026-09-17: no rule broken; EBL rose 6.2%, the largest move." mem-54</div>
</div>

<!-- Sources: src/agent/memory.ts (H-MEM, vendor/hmem; recall by tag), src/agent/world.ts (World Model; the World record trace line lists run_query_ids, for example run_query_ids=c423d2a2-a433-4d0f-a15b-b4560a5ded3e,5676c14a-95d6-41a0-a84f-625c55de0e80 in logs/trace-deck-1.jsonl). The quote is memory mem-54, a real memory: written by the run example_4 (output_examples/traces/ledger.jsonl, memoryId mem-54, content as quoted) and recalled in output_examples/traces/trace-example_6a.jsonl, trace-example_7b.jsonl and trace-example_8.jsonl (Memory recall line by_tag=mem-54). The owner's correction is mem-61, mined by example_7a (trace-example_7a.jsonl, Memory learn line, tags event:user_correction,correction,2026-09-24). No saved trace in output_examples/traces/ shows a correction recalled (every recall line says corrections=none). The recall and use of a correction is proven by the test "recalls the correction by tag on 1 Oct, applies it and says so in What I remembered" in src/agent/corrections.test.ts, and evals/E2E.md (23 Oct run) lists example_7b seeing mem-58 (correction). -->

---

## Audit by design

<div class="diagram chain" style="grid-template-columns: repeat(5, 1fr); gap: 10px 36px;">
<div class="box n">Planner</div>
<div class="box n">Analyst</div>
<div class="box n">Evaluator</div>
<div class="box n">Writer</div>
<div class="box">Memory</div>
<div></div>
<div class="guard">beforeQuery: every query</div>
<div class="guard">checkCitations: every number</div>
<div></div>
<div class="guard">beforeRemember: every memory write</div>
<div class="guard" style="grid-column: 1 / 5;">afterModel: every model reply</div>
<div></div>
</div>

<div class="cards"><ul class="p"><li>No advice.</li><li>No number without a source.</li><li>Data is never an instruction.</li></ul></div>

<!-- Sources: src/agent/guards.ts: beforeQuery (guards.ts line 70), afterModel (line 199), checkCitations (line 379), beforeRemember (line 448); each writes a Guard line to the trace (the deck-1 trace has 13 Guard lines, all allow). The flow is the loop on the previous diagram slide (slide 5) plus the Memory write. The promises: AGENTS.md rules 6 to 8 (guards, data is not instructions, no advice) and the citation check (every number is in the rows it cites). -->

---

## The owner decides

![bg right:40% fit](queue.png)

<div class="diagram" style="grid-template-columns: 1fr 40px 1.15fr; gap: 8px 0;">
<div class="box" style="grid-row: 1; grid-column: 1;">Trade plan p-02: buy 70 WALTONHIL</div>
<div class="arrow v" style="grid-row: 2; grid-column: 1;"></div>
<div class="box" style="grid-row: 3; grid-column: 1;">what_if previews it</div>
<div class="arrow v" style="grid-row: 4; grid-column: 1;"></div>
<div class="box" style="grid-row: 5; grid-column: 1;">Rule check, in code</div>
<div class="arrow" style="grid-row: 5; grid-column: 2;"></div>
<div class="box no" style="grid-row: 1 / 6; grid-column: 3; align-self: stretch; flex-direction: column; font-size: 24px;"><b>needs_human</b>Engineering: 0% to 11.9%, target 5%. Nothing has been saved; the decision is yours.</div>
</div>

<!-- Sources: fresh real-model run deck-6a (input_examples/example_6a.json with run_id deck-6a), logs/trace-deck-6a.jsonl through GET /run/deck-6a: Orchestrator fixed_plan line "5 steps, no Planner call", Orchestrator branch line "the trade would newly break sector_target ... decided in code from the what_if rows, never by a model", run_end status=needs_human. Reply output.escalation: rule sector_target, sector Engineering, before 0, after 11.88, message "Engineering is 11.9% of the portfolio, 6.9 points above your 5% target"; the review ends "Nothing has been saved; the decision is yours." The 5% target is in the message and in data/README.md (plan p-02, buy 70 WALTONHIL). src/agent/pre-trade.ts builds the fixed plan. queue.png is localhost:8000/explain/queue (Pending Approvals), first row deck-6a. -->

---

## How it was built

<div class="diagram" style="grid-template-columns: repeat(4, 1fr); gap: 10px 14px;">
<div class="box sp">Claude Code in Orca's terminal</div>
<div class="box">AGENTS.md</div>
<div class="box">7 rules</div>
<div class="box">7 skills</div>
<div class="box">2 subagents</div>
<div class="box">Guard hooks</div>
<div class="box">Step prompts</div>
<div class="box">BUILD-LOG.md: 98 entries</div>
<div class="strip" style="grid-column: 1 / 5;">What was unique: every number re-checked against its rows; corrections mined into H-MEM; reconciliation joins both databases.</div>
</div>

Every step was a prompt with its own tests: 941 tests, 25 eval cases.

<!-- Sources: .claude/ in the repo: 7 rules (.claude/rules/*.md), 7 skills (.claude/skills/), 2 subagents (.claude/agents/judge.md and reviewer.md), the guard hooks and their adapter described in AGENTS.md; AGENTS.md; BUILD-LOG.md has 98 dated rows; git rev-list --count pre-hackathon..HEAD is 127 commits. 941 tests: the count printed by npx vitest run (86 files, 941 passed) on 24 Oct. 25 eval cases: evals/RESULTS.md sample-mode table (25 passed). What was unique: the Evaluator's code check rejects a finding whose number is not in the rows it cites (src/agent/guards.ts checkCitations, trace Evaluator code_check lines); the correction path is src/agent/corrections.test.ts and trace-example_7a.jsonl (Memory learn, mem-61); the reconciliation SQL is in docs/zetaris-queries.md. Cursor is not used (metadata.json sponsors.cursor). -->

---

## Results, limits, next

<div class="cards" style="grid-template-columns: repeat(3, 1fr); gap: 10px 12px;">
<div class="box ok">Sample mode: 25 of 25</div>
<div class="box">Real model: 20 of 25, best 24</div>
<div class="box">End to end: 10 of 11</div>
<div class="box">Limits: 3 rounds, 20 queries, 54 calls</div>
<div class="box">Next: steadier real runs</div>
<div class="box sp">H-MEM, World Model: tests pass</div>
<div class="box" style="grid-column: 1 / 4; min-height: 50px;">Next.js, Nemotron 3.5 Lightning, Zetaris, Meterless Nightshift, Claude Code, Docker</div>
</div>

Every real model call went through Meterless Nightshift, 49 of 51 on the nemotron-3.5-lightning lane.

<!-- Sources: Sample mode 25 of 25: evals/RESULTS.md "Sample mode (2026-10-24)" Totals 25 passed, 0 failed. Real model 20 of 25: evals/RESULTS.md "Real model, run 7 (2026-10-24)" Totals 20 passed, 5 failed; best 24 of 25: "Real model, run 5 (2026-10-24)" Totals 24 passed, 1 failed. End to end 10 of 11: evals/E2E.md "Planted scenarios", 10 of 11 passed (example_5 failed). Limits: src/agent/config.ts defaults (3 rounds, 20 query calls, 54 model calls). Next: README.md Limitations (the real-model pass rate moves between runs). The H-MEM and World Model tests: src/agent/memory.test.ts, src/agent/world.test.ts and src/agent/corrections.test.ts. Stack: package.json (Next.js), the Nemotron 3.5 Lightning lane in evals/RESULTS.md, src/agent/zetaris.ts, src/agent/llm.ts (Meterless Nightshift), Claude Code (BUILD-LOG.md), Dockerfile. Lane evidence: the model_call lines in output_examples/traces/ that carry routed_model and cost_usd: 51 lines, 49 routed to openrouter/nvidia/nemotron-3.5-lightning and 2 to openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, all through Meterless Nightshift (provider_host 127.0.0.1, the Nightshift runtime). -->
