// Claude Code hook adapter: runs the Cursor guards in .cursor/hooks/ unchanged, so both editors share one set of rules.
// Usage (from .claude/settings.json): node .claude/hooks/cursor-adapter.mjs read | shell | prompt
// Reads Claude Code's hook JSON on stdin. Prints nothing to allow, so Claude Code's own permission prompts still apply.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const kind = process.argv[2];
const guards = { read: "guard-read.mjs", shell: "guard-shell.mjs", prompt: "guard-prompt.mjs" };
const root = process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// What guard-read treats as secret, plus what .cursorignore hides and the prep folder's env backup.
const PROTECTED = /(^|\/)\.env(\.|$)|\.(pem|key)$|(^|\/)secrets\/|(^|\/)\.hackathon-prep\/|(^|\/)data\/memory\/|(^|\/)logs\/[^/]*\.jsonl$|env-backup/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next"]);
// Past these limits the hook could run out of time, which would let the call through, so it denies instead.
const MAX_FILES = 20000;
const MAX_CHECKS = 12;

// Only these glob characters are translated; any other glob is refused, so the check can't read it differently
// from ripgrep (no [classes], ?, \, !, spaces or several patterns in one).
const SAFE_GLOB = /^[A-Za-z0-9_.\-/*{},]+$/;

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
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|{}]/g, "\\$&");
  }
  if (braces > 0) throw new Error("unclosed {");
  return new RegExp(`(^|/)${re}$`, "i");
}

const isFolder = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// A path, absolute or relative to the repo, as the repo-relative form PROTECTED is written for.
const fromRoot = (full) => relative(root, full).split(sep).join("/");
const isProtected = (rel) => PROTECTED.test(rel) && !/(^|\/)\.env\.example$/i.test(rel);

// Every protected file under dir, as [path relative to dir, path relative to the repo]; throws when there are
// too many files to walk in time. node_modules, .git and .next are not walked: globs that name them are refused.
function protectedFiles(dir) {
  const found = [];
  let seen = 0;
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (++seen > MAX_FILES) throw new Error("too many files");
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (isProtected(fromRoot(join(dir, path)))) found.push(path);
    }
  };
  walk("");
  return found;
}

// A glob overrides Grep's skipping of hidden and git-ignored files, so a glob such as "*" can reach .env.
// Returns a reason to deny, or null when no protected file under the search folder matches the glob.
function globProblem(event) {
  const tool = event.tool_input ?? {};
  const glob = tool.glob;
  if (typeof glob !== "string" || glob === "") return null;
  if (!SAFE_GLOB.test(glob)) return "The Grep glob uses characters this guard can't check (allowed: letters, digits, - _ . /, * and {a,b}). Use a plain glob, such as *.ts.";
  if ([...SKIP_DIRS].some((dir) => glob.includes(dir))) return "The Grep glob names node_modules, .git or .next, which this guard doesn't check. Search the project's own folders.";
  let match;
  try {
    match = globToRegExp(glob);
  } catch {
    return "The Grep glob could not be read, so it could reach a secret file. Use a plain glob, such as *.ts.";
  }
  const scope = resolve(event.cwd ?? root, typeof tool.path === "string" && tool.path !== "" ? tool.path : ".");
  if (!isFolder(scope)) return null;
  let files;
  try {
    files = protectedFiles(scope);
  } catch {
    return "The search folder is too big to check against the glob. Set path to a smaller folder, such as src.";
  }
  const hit = files.find((file) => match.test(file));
  return hit ? `The Grep glob also matches ${hit}, which holds secrets or is hidden from the agent. Narrow the glob, or set path to src.` : null;
}

// A read or search inside a folder that .cursorignore hides (or of a secret file) is refused, whatever guard-read says.
function pathProblem(event) {
  const tool = event.tool_input ?? {};
  for (const p of [tool.file_path, tool.notebook_path, tool.path]) {
    if (typeof p !== "string" || p === "") continue;
    const full = resolve(event.cwd ?? root, p);
    let real = full;
    try {
      if (existsSync(full)) real = realpathSync(full);
    } catch {
      // Unresolvable: the path as given is still checked.
    }
    for (const candidate of [full, real]) {
      const rel = fromRoot(candidate);
      if (!rel.startsWith("..") && (isProtected(rel) || ((isFolder(candidate) || !existsSync(candidate)) && isProtected(`${rel}/`))))
        return `${p} holds secrets or is hidden from the agent (.cursorignore). Use an endpoint or a command instead.`;
    }
  }
  return null;
}

// guard-read matches names, so every name a read could reach is checked: the path as given, where a symlink
// really points (a folder with a trailing slash, so secrets/ is caught), and the literal parts of a Grep glob.
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
    targets.push(p, isFolder(real) ? `${real}/` : real);
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
  if (kind === "read") {
    const problem = pathProblem(event) ?? globProblem(event);
    if (problem) return deny(problem);
  }
  const payloads = cursorPayloads(event);
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
