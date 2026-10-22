// Claude Code hook adapter: runs the Cursor guards in .cursor/hooks/ unchanged, so both editors share one set of rules.
// Usage (from .claude/settings.json): node .claude/hooks/cursor-adapter.mjs read | shell | prompt
// Reads Claude Code's hook JSON on stdin. Prints nothing to allow, so Claude Code's own permission prompts still apply.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
// The owner can let an unattended run push without a question. The switch lives outside the repo, holds the exact
// push URL of origin, and the agent may not read, write or touch it (below), so the agent can't approve itself.
// Only the plain push to origin main, from the repo, to that URL, with no mirror setting, is let through.
// The path override exists only for the kit tests (vitest sets VITEST); a real session always uses the home path.
const PUSH_SWITCH = (process.env.VITEST && process.env.CLAUDE_KIT_ALLOW_PUSH_FILE) || join(homedir(), ".config", "tradeflow-kit", "allow-push");
const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 3000 }).stdout?.trim() ?? "";
function pushAllowed(command, cwd) {
  if (!/^\s*git push origin main\s*$/.test(command ?? "") || !existsSync(PUSH_SWITCH)) return false;
  if (cwd && !fromRoot(resolve(cwd)).includes("")) return false;
  let pinned = "";
  try {
    pinned = readFileSync(PUSH_SWITCH, "utf8").trim();
  } catch {
    return false;
  }
  // Any setting that changes where or how a push goes (a refspec, push URL, receive-pack, mirror, an included config file,
  // an ssh command, a hooks folder other than the kit's, or a pre-push hook) means the owner didn't approve this push.
  const redirects = git("config", "--get-regexp", "^remote\\.origin\\.(push|pushurl|receivepack|mirror)$|^include(if)?\\.|^core\\.sshcommand$");
  const hooksPath = git("config", "--get", "core.hooksPath");
  const prePush = [join(root, ".githooks", "pre-push"), join(root, ".git", "hooks", "pre-push")].some((p) => existsSync(p));
  return pinned !== "" && pinned === git("remote", "get-url", "--push", "origin") && redirects === "" &&
    (hooksPath === "" || hooksPath === ".githooks") && !prePush;
}
// Shell commands that could fake the owner's consent or move where a push goes.
const CONSENT_TAMPER = /allow-push|tradeflow-kit|\bgit\s+remote\s+(add|set-url|rename|remove|rm)\b|\bgit\s+config\b[^\n]*\b(remote\.|url\.|core\.hookspath|pushurl)/i;

// Only these glob characters are translated; any other glob is refused, so the check can't read it differently
// from ripgrep (no [classes], ?, \, !, spaces or several patterns in one).
const SAFE_GLOB = /^[A-Za-z0-9_.\-/*{},]+$/;

// A Grep glob as a regular expression, matching dotfiles the way ripgrep does. Throws on a malformed glob.
// It matches at least what ripgrep would: a leading / (anchored to the search folder) is dropped and the pattern
// may start at any folder, and a trailing / (a folder) matches everything inside it.
function globToRegExp(raw) {
  const glob = raw.replace(/^\/+/, "").replace(/\/$/, "/**");
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

// The repo as given and as its real path, so a symlinked project folder can't make a path look outside it.
const roots = (() => {
  try {
    return [...new Set([root, realpathSync(root)])];
  } catch {
    return [root];
  }
})();
// An absolute path as the repo-relative forms PROTECTED is written for; empty when it is outside the repo.
const fromRoot = (full) =>
  roots
    .map((r) => relative(r, full).split(sep).join("/"))
    .filter((rel) => rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
const isProtected = (rel) => PROTECTED.test(rel) && !/(^|\/)\.env\.example$/i.test(rel);
// The repo-relative forms and the absolute path, so a key file outside the repo is caught as well.
const forms = (full) => [...fromRoot(full), full.split(sep).join("/")];
const isProtectedPath = (full) => forms(full).some(isProtected);

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
      } else if (isProtectedPath(join(dir, path))) found.push(path);
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
  // A glob that matches a folder can bring in the files under it, so each file's parent folders are tried too.
  const withParents = (file) => file.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const hit = files.find((file) => withParents(file).some((p) => match.test(p)));
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
      const asFolder = isFolder(candidate) || !existsSync(candidate);
      if (forms(candidate).some((rel) => isProtected(rel) || (asFolder && isProtected(`${rel}/`))))
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
    const tool = event.tool_input ?? {};
    const touchesSwitch = [tool.file_path, tool.notebook_path, tool.path, tool.glob].some(
      (p) => typeof p === "string" && /allow-push|tradeflow-kit/i.test(p));
    if (touchesSwitch) return deny("The push switch is the owner's consent; only the owner may create or change it.");
    // The agent may not rewrite git's config or hooks, or its own guards and settings, with a file tool.
    const writes = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(event.tool_name ?? "");
    const guarded = [tool.file_path, tool.notebook_path].some((p) => typeof p === "string" &&
      fromRoot(resolve(event.cwd ?? root, p)).some((rel) => /^(\.git\/|\.githooks\/|\.claude\/hooks\/|\.cursor\/hooks\/|\.claude\/settings[^/]*\.json$|\.cursor\/hooks\.json$)/.test(rel)));
    if (writes && guarded) return deny("Git's config and hooks, and the kit's guards and settings, are the owner's to change.");
    const problem = pathProblem(event) ?? globProblem(event);
    if (problem) return deny(problem);
  }
  if (kind === "shell" && CONSENT_TAMPER.test(event.tool_input?.command ?? ""))
    return deny("That command touches the owner's push switch or git remotes, which only the owner may change.");
  const payloads = cursorPayloads(event);
  if (payloads.length > MAX_CHECKS) return deny(`Too many paths to check (${payloads.length}); split the request.`);
  let ask = null;
  for (const payload of payloads) {
    const out = runGuard(payload);
    if (!out) return deny(`The ${kind} guard gave no answer, so this was stopped. Run: node .cursor/hooks/${guards[kind]}`);
    if (kind === "prompt" && out.continue === false) return process.stdout.write(JSON.stringify(reply("block", out.user_message)));
    if (out.permission === "deny") return deny(out.agent_message ?? out.user_message);
    if (out.permission === "ask" && !(kind === "shell" && pushAllowed(payload.command, payload.cwd))) ask ??= out.agent_message ?? out.user_message;
  }
  if (ask) process.stdout.write(JSON.stringify(reply("ask", ask)));
});
