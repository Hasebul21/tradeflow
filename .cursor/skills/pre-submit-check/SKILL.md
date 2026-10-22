---
name: pre-submit-check
description: Run the full pre-submission check of the Tradeflow hackathon entry and report what would cost points.
disable-model-invocation: true
---
Run each and report pass or fail with evidence. Don't fix anything without asking.

1. `npm run check` and `npm run eval -- --no-results`.
2. The judges' clean-clone run: `scripts/clean-clone.sh`, or by hand: clone the GitHub repo to a temporary folder, `cp .env.example .env` with empty keys, `docker build -t oah-submission .`, `docker run --rm -e PORT=8000 -p 8000:8000 --env-file .env oah-submission`, then POST input_examples/example_1.json to /run. Expect status success, a trace file, and the container healthy in `docker ps`.
3. Secret scan: `git ls-files -- '.env' '*.env' '.env.*' '*.pem' '*.key' 'secrets/*'` must list only .env.example, and `git log -p | grep -cE 'nvapi-[A-Za-z0-9_-]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|postgres(ql)?://[^:/ ]+:[^@ <>]+@|BEGIN (RSA|OPENSSH) PRIVATE KEY'` must print 0, and `sh .githooks/scan-history.sh` must exit 0 (it looks for the values of the keys and passwords in .env, which have no published prefix). Report hits by file and commit, never the value.
4. README claims: for every sentence that claims a capability or a sponsor integration, find the code that does it, and list any claim without code.
5. Required files: Dockerfile, .env.example, input_examples (3+), output_examples, a logs/ trace from a run, metadata.json, README sections (setup, usage, architecture, agent roles, examples, limits, AI usage, licences).
6. Pre-existing: git diff pre-hackathon --stat, and check PRE-EXISTING.md declares the kit and anything else made before the build window. Nothing under src/lib/ or in scripts/seed.mjs, seed-data.mjs, load-postgres.mjs or db-schema.mjs should have changed since the tag, and data/ only by fixes the owner approved in the reconciliation agent.
7. Organiser self-check (resources: disqualification checklist): the HackOS submission will be sent hours before 27 Oct 23:45 UTC, from the owner's one account; no tracked file is over 5,000 KB (git ls-files -z | xargs -0 du -k | sort -rn | head -5); nothing in src/ reads output_examples/ (grep -rn output_examples src/); the trace of a run shows at least two named agents and one critique, retry or branch event; the README states that all data is synthetic and what sample mode does.
