# End-to-end check of the planted scenarios, 2026-10-23, provider 127.0.0.1:8088

Run with npm run e2e:live -- --concurrency 4, server MAX_CONCURRENT_RUNS=4, runner exit code 1

```text
In case order:
example_1  200  success  -  1072.7 s  6 model calls  memory: by_tag=none; by_query=none
example_2  200  success  -  575.7 s  6 model calls  memory: by_tag=none; by_query=none
example_3a  200  success  -  1374.5 s  7 model calls  memory: by_tag=none; by_query=none
example_3b  200  success  -  954.2 s  5 model calls  memory: by_tag=mem-55 (review of example_3a); by_query=none
example_4  200  success  -  542.3 s  4 model calls  memory: by_tag=none; by_query=none
example_5  500  error  PromptTooLarge  1094.4 s  4 model calls  memory: by_tag=mem-51; by_query=none  [unexpected error]
example_6a  200  needs_human  -  515.6 s  3 model calls  memory: by_tag=mem-51 (review of example_4); by_query=none
example_6b  200  success  -  1888.7 s  6 model calls  memory: by_tag=mem-51 (review of example_4); by_query=none
example_7a  200  success  -  3.1 s  1 model calls
example_7b  200  success  -  474.7 s  4 model calls  memory: by_tag=mem-58 (correction), mem-55 (review of example_3a); by_query=none
example_8  200  needs_human  -  604.6 s  3 model calls  memory: by_tag=mem-51 (review of example_4); by_query=none

11 cases in 49.4 min: 10 results, 0 expected errors, 1 unexpected errors, 0 no result or not run, 0 missing. Exit 1. Saved to /Users/cefalo/tradeflow/logs/e2e-live
```

Reruns:

- example_5, rerun on the merged code (aefd965, the fix in `1a0149d`): status `needs_human`, stop reason `model_unavailable`, 2 rounds. The code draft was returned and the error did not surface, but round 2's second Analyst call was 40,030 characters, over MAX_PROMPT_CHARS (40,000). Counted as FAIL. The owner ran this rerun, so its tokens, time and model calls are not recorded here. The original error row above stays.
- example_5: not a lane failure, so the prompt gives it no lane rerun. A single self-check rerun started, then the owner cancelled it (`stop_reason` cancelled, 0 tokens) because the server ran the old code and would fail the same way. It stays failed until the fix is merged and the server restarted.

## Planted scenarios

10 of 11 passed. 0 lane failures, 1 content failure (example_5).

| Case | Result | Status | Stop reason | Rounds | Evaluator total | Citations | Model calls | Tokens | Seconds | Memory seen | Failed check |
|---|---|---|---|---|---|---|---|---|---|---|---|
| example_1 | pass | success | - | 1 | 8 of 9 | 3 | 6 | 83,583 | 1072.7 | none | - |
| example_2 | pass | success | - | 2 | 9 of 9 | 4 | 6 | 54,839 | 575.7 | none | - |
| example_3a | pass | success | - | 1 | 8 of 9 | 5 | 7 | 121,619 | 1374.5 | none | - |
| example_3b | pass | success | - | 1 | 9 of 9 | 3 | 5 | 79,814 | 954.2 | mem-55 (review of example_3a) | - |
| example_4 | pass | success | - | 1 | 9 of 9 | 3 | 4 | 30,099 | 542.3 | none | - |
| example_5 | fail | error (HTTP 500 PromptTooLarge) | - | 2 | - | - | 4 | 75,057 | 1094.4 | mem-51 | status success: the Analyst's retry batch prompt was 45,480 characters, over MAX_PROMPT_CHARS (40,000) |
| example_5 (rerun on aefd965) | fail | needs_human (stop reason model_unavailable) | model_unavailable | 2 | - | - | not recorded | not recorded | not recorded | not recorded | status needs_human: round 2's second Analyst call was 40,030 characters, over MAX_PROMPT_CHARS (40,000), so the run ended on the code draft; the verdict checks did not run |
| example_6a | pass | needs_human | - | 1 | 9 of 9 | 2 | 3 | 28,996 | 515.6 | mem-51 (review of example_4) | - |
| example_6b | pass | success | - | 2 | 9 of 9 | 3 | 6 | 71,443 | 1888.7 | mem-51 (review of example_4) | - |
| example_7a | pass | success | - | 0 | - | 0 | 1 | 906 | 3.1 | - | - |
| example_7b | pass | success | - | 1 | 9 of 9 | 1 | 4 | 41,997 | 474.7 | mem-58 (correction), mem-55 (review of example_3a) | - |
| example_8 | pass | needs_human | - | 1 | 9 of 9 | 1 | 3 | 29,199 | 604.6 | mem-51 (review of example_4) | - |

Notes:

- Every reply came from a real model (`output.model_source` names `openrouter/nvidia/nemotron-*` or `meterless/fast`, never `sample-model`).
- No trace has a `planner_fallback` line, and no reply says "Nightshift not running" or "unauthorized".
- example_5 ran 15 thesis findings in batch 1, then a revision round (finding 24 had verdict null). The revision's second batch prompt then crossed the limit. The run ended with `output: null`.
- Rounds and Evaluator total for example_5 come from its trace, because the error reply has no output.

## Full rerun on the merged fix (aefd965), 2026-10-23

Ran all 11 planted cases again through POST /run against a fresh server (MAX_CONCURRENT_RUNS=4, fresh data dir /tmp/tf-17b), 4 at a time. Runner exit code 1.

```text
In case order:
example_1  200  success  -  966.1 s  6 model calls  memory: by_tag=none; by_query=none
example_2  200  success  -  1081.7 s  7 model calls  memory: by_tag=none; by_query=none
example_3a  200  success  -  564.0 s  4 model calls  memory: by_tag=none; by_query=none
example_3b  200  success  -  722.1 s  4 model calls  memory: by_tag=mem-51 (review of example_3a); by_query=none
example_4  200  success  -  618.4 s  6 model calls  memory: by_tag=none; by_query=none
example_5  500  error  PromptTooLarge  878.2 s  3 model calls  memory: by_tag=mem-51; by_query=none  [unexpected error]
example_6a  200  needs_human  -  472.4 s  3 model calls  memory: by_tag=mem-51 (review of example_3a); by_query=none
example_6b  200  success  -  869.7 s  6 model calls  memory: by_tag=mem-51 (review of example_3a); by_query=none
example_7a  200  success  -  8.1 s  1 model calls
example_7b  200  success  -  658.5 s  7 model calls  memory: by_tag=mem-56 (correction), mem-51 (review of example_3a); by_query=none
example_8  200  needs_human  -  391.5 s  3 model calls  memory: by_tag=mem-56 (correction), mem-51 (review of example_3a); by_query=none

11 cases: 10 results, 0 expected errors, 1 unexpected errors. Exit 1.
```

| Case | Result | Status | Stop reason | Rounds | Evaluator total | Citations | Model calls | Tokens | Seconds | Memory seen | Failed check |
|---|---|---|---|---|---|---|---|---|---|---|---|
| example_1 | pass | success | - | 1 | 9 of 9 | 4 | 6 | 88,917 | 966.1 | none | - |
| example_2 | pass | success | - | 2 | 9 of 9 | 3 | 7 | 50,210 | 1081.7 | none | - |
| example_3a | pass | success | - | 1 | 9 of 9 | 4 | 4 | 43,113 | 564.0 | none (wrote mem-51) | - |
| example_3b | pass | success | - | 1 | 9 of 9 | 5 | 4 | 56,792 | 722.1 | mem-51 (review of example_3a) | - |
| example_4 | pass | success | - | 1 | 9 of 9 | 3 | 6 | 57,775 | 618.4 | none | - |
| example_5 | fail | error (HTTP 500 PromptTooLarge) | - | 2 | - | - | 3 | 67,382 | 878.2 | mem-51 | status success: the Evaluator's scoring call was 58,665 characters, over MAX_PROMPT_CHARS (40,000); only the Analyst's PromptTooLarge is caught |
| example_6a | pass | needs_human | - | 1 | 7 of 9 | 2 | 3 | 30,223 | 472.4 | mem-51 (review of example_3a) | - |
| example_6b | pass | success | - | 2 | 9 of 9 | 3 | 6 | 99,166 | 869.7 | mem-51 (review of example_3a) | - |
| example_7a | pass | success | - | 0 | - | 0 | 1 | 1,773 | 8.1 | - | - |
| example_7b | pass | success | - | 2 | 9 of 9 | 1 | 7 | 78,400 | 658.5 | mem-56 (correction), mem-51 (review of example_3a) | - |
| example_8 | pass | needs_human | - | 1 | 9 of 9 | 4 | 3 | 30,213 | 391.5 | mem-56 (correction), mem-51 (review of example_3a) | - |

Notes:

- Chain memory propagated as planted: example_3a wrote mem-51 (its review); example_3b, example_6a, example_6b recalled it; example_7b and example_8 recalled mem-51 and mem-56 (the correction example_7a wrote).
- Both planted needs_human outcomes landed (example_6a: pre-trade blocked, "Nothing has been saved"; example_8: reconciliation proposals listed, nothing applied).
- example_5 is a second variant of the PromptTooLarge bug: this time the Evaluator's scoring prompt crossed MAX_PROMPT_CHARS (58,665 characters, ~30 findings across two thesis batches plus cited evidence), and the catch at orchestrator.ts that routes PromptTooLarge to needs_human covers only `calling === "Analyst"`, so the Evaluator re-threw and the run surfaced as HTTP 500. The Analyst-side cut (previous_left_out) worked: no Analyst call went over the limit in this run.
- Every reply came from a real model (`output.model_source` names `openrouter/nvidia/nemotron-*` or `meterless/fast`, never `sample-model`). No trace has a `planner_fallback` line.
- Content checks: 74 of 74 substantive checks pass on the 10 finished cases (claims, planted outcomes, no advice, disclaimer, usage, trace order, memory propagation). The two script-level mismatches were wording (the review carries "2026-09-24"; example_7a's field is `memory_ids_added`), not the runs.
