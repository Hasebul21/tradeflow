// Claude Code hook adapter: runs the Cursor guards in .cursor/hooks/ unchanged, so both editors share one set of rules.
// Usage (from .claude/settings.json): node .claude/hooks/cursor-adapter.mjs read | shell | prompt
// Reads Claude Code's hook JSON on stdin. Prints nothing to allow, so Claude Code's own permission prompts still apply.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kind = process.argv[2];
const guards = { read: "guard-read.mjs", shell: "guard-shell.mjs", prompt: "guard-prompt.mjs" };
const root = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// guard-read matches a file's name, so every name a read could reach is checked: the path as given, where a
// symlink really points, and a Grep glob with its wildcards removed (".env*" is checked as ".env").
function readTargets(event) {
  const tool = event.tool_input ?? {};
  const paths = [tool.file_path, tool.notebook_path, tool.path].filter((p) => typeof p === "string" && p !== "");
  const targets = [...paths];
  for (const p of paths) {
    const full = resolve(event.cwd ?? root, p);
    try {
      if (existsSync(full)) targets.push(realpathSync(full));
    } catch {
      // An unreadable path can't be resolved; the path as given is still checked.
    }
  }
  if (typeof tool.glob === "string" && tool.glob !== "") {
    const plain = tool.glob.replace(/[*?[\]]/g, "");
    targets.push(plain, ...plain.split(/[{},]/).filter(Boolean));
  }
  return targets.length > 0 ? targets : [""];
}

function cursorPayloads(event) {
  if (kind === "read") return readTargets(event).map((file_path) => ({ file_path }));
  if (kind === "shell") return [{ command: event.tool_input?.command ?? "", cwd: event.cwd ?? root }];
  return [{ prompt: event.prompt ?? "" }];
}

function runGuard(payload) {
  const run = spawnSync(process.execPath, [join(root, ".cursor", "hooks", guards[kind])], {
    input: JSON.stringify(payload),
    cwd: root,
    encoding: "utf8",
    timeout: 4000,
  });
  if (run.stderr) process.stderr.write(run.stderr);
  try {
    return JSON.parse(run.stdout);
  } catch {
    // A guard that crashed or timed out gives no answer; the caller fails closed rather than let a secret through.
    return null;
  }
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
  let ask = null;
  for (const payload of cursorPayloads(event)) {
    const out = runGuard(payload);
    if (!out) {
      process.stdout.write(JSON.stringify(reply("deny", `The ${kind} guard gave no answer, so this was stopped. Run: node .cursor/hooks/${guards[kind]}`)));
      return;
    }
    if (kind === "prompt" && out.continue === false) {
      process.stdout.write(JSON.stringify(reply("block", out.user_message)));
      return;
    }
    if (out.permission === "deny") {
      process.stdout.write(JSON.stringify(reply("deny", out.agent_message ?? out.user_message)));
      return;
    }
    if (out.permission === "ask") ask ??= out.agent_message ?? out.user_message;
  }
  if (ask) process.stdout.write(JSON.stringify(reply("ask", ask)));
});
