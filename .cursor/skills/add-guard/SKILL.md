---
name: add-guard
description: Add a runtime guard to src/agent/guards.ts, the checks that run before a query, after a model reply or before a memory write.
paths: src/agent/guards.ts
---
1. A guard is a function with no side effects other than its Guard trace line, returning { ok: true } or { ok: false, reason }.
2. Decide where it runs: beforeQuery (query id and params), afterModel (schema, advice wording, injection signs, numbers), or beforeRemember (what may enter memory).
3. Log every decision through the tracer as agent_name "Guard", with the reason. A guard never throws on bad input; it rejects it.
4. Write two tests: one input it allows, one it blocks.
5. Add a row to the README's guard table: name, where it runs, what it blocks.
