---
paths:
  - "README.md"
  - "metadata.json"
  - "CURSOR.md"
  - "docs/**"
---
- Judges score Sponsor Tech from what we write, and misrepresenting the project is a disqualifier. Claim only what the code does, and point to it.
- For each sponsor tool give: what it does in the agent loop, the file and function, and how to see it working:
  Zetaris: src/agent/zetaris.ts, the named queries that have sql() (list them), the cross-database reconciliation query if built, npm run parity.
  Meterless H-MEM: vendor/hmem, src/agent/memory.ts, a trace line with retrievalReason, a recalled correction; call it a working Meterless Engine feature and name its passing test, src/agent/memory.test.ts.
  Meterless World Model: vendor/world-model, src/agent/world.ts, facts with their run_query_id; call it a working Meterless Engine feature and name its passing tests, src/agent/world.test.ts and src/agent/corrections.test.ts.
  Nemotron endpoint: Meterless Nightshift (primary): src/agent/llm.ts, METERLESS_BASE_URL (the Nightshift Runtime URL); every Nemotron call goes through that one endpoint, and name the lane that served the real runs. A direct NVIDIA or OpenRouter endpoint is only a development or secondary provider; the README and the demo must show Nightshift as primary.
  NVIDIA Nemotron: the model id for each agent in src/agent/config.ts.
  Cursor: .cursor/, AGENTS.md, CURSOR.md. If Claude Code was also used, say so.
- The README's "Sponsor technology" section is the source; metadata.json and the submission text are copied from it.
- Say what is synthetic (all of data/), what was pre-existing (everything at the tag, including attribution, what-if and reconciliation), what sample mode does, and the limits. No "real-time", "production-ready" or "semantic" unless true.
- The README's AI usage section gives the organisers' 8 disclosures: models and providers; agent frameworks; partner technologies and where; external tools and libraries; data sources (all synthetic); open-source code adapted; known limitations; fallback and sample-mode behaviour.
- Frame the project as agents you can audit: every claim cites its query, a separate Evaluator rejects what the rows can't show, and the owner decides. The Dhaka Stock Exchange ledger is the worked example, on synthetic data. Never claim users, adoption or savings the project doesn't have.
- Plain words, short sentences, British spelling.
