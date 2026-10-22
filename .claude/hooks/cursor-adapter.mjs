// Claude Code hook adapter: runs the Cursor guards in .cursor/hooks/ unchanged, so both editors share one set of rules.
// Usage (from .claude/settings.json): node .claude/hooks/cursor-adapter.mjs read | shell | prompt
// Reads Claude Code's hook JSON on stdin. Prints nothing to allow, so Claude Code's own permission prompts still apply.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kind = process.argv[2];
const guards = { read: "guard-read.mjs", shell: "guard-shell.mjs", prompt: "guard-prompt.mjs" };
const root = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function cursorPayload(event) {
  const tool = event.tool_input ?? {};
  if (kind === "read") return { file_path: tool.file_path ?? tool.notebook_path ?? tool.path ?? "" };
  if (kind === "shell") return { command: tool.command ?? "", cwd: event.cwd ?? root };
  return { prompt: event.prompt ?? "" };
}

function reply(decision, reason) {
  if (kind === "prompt") return { decision: "block", reason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  if (!guards[kind]) {
    process.stderr.write(`cursor-adapter: unknown guard "${kind}"; expected read, shell or prompt\n`);
    process.exit(2);
  }
  let event = {};
  try {
    event = JSON.parse(input);
  } catch {
    // Unreadable input: the guard gets empty fields, as in Cursor.
  }
  const run = spawnSync(process.execPath, [join(root, ".cursor", "hooks", guards[kind])], {
    input: JSON.stringify(cursorPayload(event)),
    cwd: root,
    encoding: "utf8",
    timeout: 4000,
  });
  if (run.stderr) process.stderr.write(run.stderr);
  let out = null;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    // A guard that crashed or timed out gives no answer; fail closed below rather than let a secret through.
  }
  if (!out) {
    process.stdout.write(JSON.stringify(reply("deny", `The ${kind} guard gave no answer, so this was stopped. Run: node .cursor/hooks/${guards[kind]}`)));
    return;
  }
  if (kind === "prompt" && out.continue === false) process.stdout.write(JSON.stringify(reply("block", out.user_message)));
  if (kind !== "prompt" && (out.permission === "deny" || out.permission === "ask"))
    process.stdout.write(JSON.stringify(reply(out.permission, out.agent_message ?? out.user_message)));
});
