// Claude Code hook adapter: runs the Cursor guards in .cursor/hooks/ unchanged, so both editors share one set of rules.
// Usage (from .claude/settings.json): node .claude/hooks/cursor-adapter.mjs read | shell | prompt
// Reads Claude Code's hook JSON on stdin. Prints nothing to allow, so Claude Code's own permission prompts still apply.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kind = process.argv[2];
const guards = { read: "guard-read.mjs", shell: "guard-shell.mjs", prompt: "guard-prompt.mjs" };
const root = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Names a Grep glob must not be able to match; guard-read decides which of them are secret.
const SAMPLE_NAMES = [".env", ".env.local", "id.pem", "id.key", "secrets/notes.txt"];
// Each check spawns the guard; past this many the hook could run out of time, so it denies instead.
const MAX_CHECKS = 12;

// A Grep glob as a regular expression, matching dotfiles the way ripgrep does. Throws on a malformed glob.
function globToRegExp(glob) {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) throw new Error("unclosed [");
      const set = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
      re += `[${set}]`;
      i = end;
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|\\{}]/g, "\\$&");
  }
  if (braces > 0) throw new Error("unclosed {");
  return new RegExp(`(^|/)${re}$`, "i");
}

// guard-read matches names, so every name a read could reach is checked: the path as given, where a symlink
// really points (a folder with a trailing slash, so secrets/ is caught), and each sample name a Grep glob matches.
function readTargets(event) {
  const tool = event.tool_input ?? {};
  const paths = [tool.file_path, tool.notebook_path, tool.path].filter((p) => typeof p === "string" && p !== "");
  const targets = [];
  for (const p of paths) {
    const full = resolve(event.cwd ?? root, p);
    let real = full;
    try {
      if (existsSync(full)) real = realpathSync(full);
    } catch {
      // An unreadable path can't be resolved; the path as given is still checked.
    }
    let folder = false;
    try {
      folder = statSync(real).isDirectory();
    } catch {
      // Not there yet: check it as a file name.
    }
    targets.push(p, folder ? `${real}/` : real);
  }
  if (typeof tool.glob === "string" && tool.glob !== "") {
    let match;
    try {
      match = globToRegExp(tool.glob);
    } catch {
      return null;
    }
    targets.push(...SAMPLE_NAMES.filter((name) => match.test(name)));
  }
  return targets.length > 0 ? targets : [""];
}

function cursorPayloads(event) {
  if (kind === "read") return readTargets(event)?.map((file_path) => ({ file_path })) ?? null;
  if (kind === "shell") return [{ command: event.tool_input?.command ?? "", cwd: event.cwd ?? root }];
  return [{ prompt: event.prompt ?? "" }];
}

function runGuard(payload) {
  const run = spawnSync(process.execPath, [join(root, ".cursor", "hooks", guards[kind])], {
    input: JSON.stringify(payload),
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
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

const deny = (reason) => process.stdout.write(JSON.stringify(reply("deny", reason)));

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
  const payloads = cursorPayloads(event);
  if (!payloads) return deny("The Grep glob could not be read, so it could reach a secret file. Use a simpler glob, such as *.ts.");
  if (payloads.length > MAX_CHECKS) return deny(`Too many paths to check (${payloads.length}); split the request.`);
  let ask = null;
  for (const payload of payloads) {
    const out = runGuard(payload);
    if (!out) return deny(`The ${kind} guard gave no answer, so this was stopped. Run: node .cursor/hooks/${guards[kind]}`);
    if (kind === "prompt" && out.continue === false) return process.stdout.write(JSON.stringify(reply("block", out.user_message)));
    if (out.permission === "deny") return deny(out.agent_message ?? out.user_message);
    if (out.permission === "ask") ask ??= out.agent_message ?? out.user_message;
  }
  if (ask) process.stdout.write(JSON.stringify(reply("ask", ask)));
});
