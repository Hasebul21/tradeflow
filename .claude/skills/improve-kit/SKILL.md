---
name: improve-kit
description: Turn mistakes the coding agent repeated during the build into one-line rules or tests, so later steps go better.
disable-model-invocation: true
---
Use when the owner types /improve-kit. Edit nothing until the owner approves.

1. Read BUILD-LOG.md, git log --oneline -15, and the diffs of any commit whose message starts with fix or test after a feat for the same files. Read any "Lesson:" lines the owner pastes after the command.
2. List the mistakes that happened more than once or cost a fix, each with the commit or BUILD-LOG.md row that shows it: for example a calculation re-implemented instead of reusing src/lib, a missing trace line, a model id hardcoded, a test weakened, a file staged that shouldn't be.
3. For at most three of them, propose one change each, in the file where the coding agent will see it next time: one line in AGENTS.md Rules, one line in the matching .claude/rules/*.md (it attaches by file path), one step in a skill's SKILL.md, or a new test that would have caught it. Quote the exact line you would add. Never loosen a rule, and never change evals/ or a guard.
4. Stop and show me the list. Only after I say which to apply: make those edits, run npm run check, stage the edited files by name, commit as "chore(kit): <what changed>", and git push origin main (the shell hook asks me).
