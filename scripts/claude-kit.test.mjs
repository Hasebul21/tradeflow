import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Claude Code kit in .claude/: its skills, rules and agents, and the guards every tool call goes through.
 */
const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");
const split = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return { front: match ? match[1] : "", body: match ? text.slice(match[0].length) : text };
};

function adapter(kind, event, extraEnv = {}) {
  const run = spawnSync(process.execPath, [".claude/hooks/cursor-adapter.mjs", kind], {
    input: JSON.stringify(event),
    cwd: root,
    encoding: "utf8",
    // A switch file that never exists, so the owner's own .run/allow-push can't change these results.
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_KIT_ALLOW_PUSH_FILE: path.join(tmpdir(), "claude-kit-no-switch"), ...extraEnv },
  });
  return { status: run.status, out: run.stdout.trim() ? JSON.parse(run.stdout) : null };
}
const decision = (result) => result.out?.hookSpecificOutput?.permissionDecision ?? null;
// Each adapter() call starts a node process, so a test that makes two dozen of them needs well over vitest's 5 s default.
const SPAWN_TIMEOUT_MS = 30_000;

describe("the Claude Code kit", () => {
  it("has a SKILL.md in every skill folder", () => {
    const skills = readdirSync(path.join(root, ".claude/skills"));
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) expect(read(`.claude/skills/${skill}/SKILL.md`)).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
  });

  it("has rules whose paths are listed one per line", () => {
    for (const file of readdirSync(path.join(root, ".claude/rules"))) {
      const { front, body } = split(read(`.claude/rules/${file}`));
      expect(body.trim().length).toBeGreaterThan(0);
      if (front) expect([...front.matchAll(/^ {2}- "(.+)"$/gm)].length).toBeGreaterThan(0);
    }
  });

  it("has the reviewer and judge agents, read-only", () => {
    const agents = readdirSync(path.join(root, ".claude/agents"));
    expect(agents).toEqual(expect.arrayContaining(["judge.md", "reviewer.md"]));
    for (const file of agents) expect(split(read(`.claude/agents/${file}`)).front).toMatch(/^tools: Read, Grep, Glob, Bash$/m);
  });

  it("wires the three guards in settings.json", () => {
    const settings = JSON.parse(read(".claude/settings.json"));
    const commands = (event) => settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => `${entry.matcher ?? ""} ${hook.command}`));
    expect(commands("PreToolUse").some((c) => c.startsWith("Read|") && c.endsWith("cursor-adapter.mjs read"))).toBe(true);
    expect(commands("PreToolUse").some((c) => c.startsWith("Bash ") && c.endsWith("cursor-adapter.mjs shell"))).toBe(true);
    expect(commands("UserPromptSubmit").some((c) => c.endsWith("cursor-adapter.mjs prompt"))).toBe(true);
    expect(settings.permissions.deny).toContain("Read(./.env)");
  });
});

describe("cursor-adapter.mjs", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("denies reading .env and allows .env.example", () => {
    expect(decision(adapter("read", { tool_name: "Read", tool_input: { file_path: `${root}/.env` } }))).toBe("deny");
    expect(adapter("read", { tool_name: "Read", tool_input: { file_path: `${root}/.env.example` } }).out).toBeNull();
  });

  it("denies a Grep that reaches .env through its glob or path", () => {
    expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "KEY", path: ".", glob: ".env*" } }))).toBe("deny");
    expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "KEY", glob: "{.env,README.md}" } }))).toBe("deny");
    expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: "secrets/" } }))).toBe("deny");
    // At the repo root these globs can reach .env, because a glob overrides Grep's skipping of ignored files.
    const refused = ["?env", "*env", "*", "**/*", ".e[n]v", ".env.production", "[env", "[]env]", "\\.env", "!*.md", "*.ts .env", "node_modules/**"];
    // Anchored globs, and globs that name a protected folder rather than a file in it.
    refused.push("/.hackathon-prep/*", ".hackathon-prep", ".hackathon-prep/", "/.env");
    for (const glob of refused) {
      expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "KEY", glob } }))).toBe("deny");
    }
    for (const glob of ["*", "*.ts", "**/*.test.ts", "*.{ts,tsx}", ".env.example"]) {
      expect(adapter("read", { tool_name: "Grep", tool_input: { pattern: "planner", path: "src", glob } }).out).toBeNull();
    }
  });

  it("denies a Grep glob that matches a key file in the search folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-kit-"));
    try {
      writeFileSync(path.join(dir, "id.pem"), "made-up\n");
      writeFileSync(path.join(dir, "notes.ts"), "made-up\n");
      expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: dir, glob: "*.{pem,ts}" } }))).toBe("deny");
      expect(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: dir, glob: "*.ts" } }).out).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies reads and searches inside the folders the kit hides", () => {
    expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: ".hackathon-prep" } }))).toBe("deny");
    expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: "data/memory" } }))).toBe("deny");
    expect(decision(adapter("read", { tool_name: "Read", tool_input: { file_path: `${root}/logs/trace-week-40.jsonl` } }))).toBe("deny");
    expect(adapter("read", { tool_name: "Read", tool_input: { file_path: `${root}/AGENTS.md` } }).out).toBeNull();
    expect(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: "data" } }).out).toBeNull();
  });

  it("still denies when the project folder is reached through a symlink", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-kit-"));
    try {
      const link = path.join(dir, "repo");
      symlinkSync(root, link);
      const run = spawnSync(process.execPath, [".claude/hooks/cursor-adapter.mjs", "read"], {
        input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(realpathSync(root), ".hackathon-prep", "README.md") } }),
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: link },
      });
      expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a plain push to origin main through only with the owner's switch holding origin's push URL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-kit-"));
    try {
      const url = spawnSync("git", ["remote", "get-url", "--push", "origin"], { cwd: root, encoding: "utf8" }).stdout.trim();
      const sw = path.join(dir, "allow-push");
      const on = { CLAUDE_KIT_ALLOW_PUSH_FILE: sw };
      const push = (command) => adapter("shell", { tool_name: "Bash", tool_input: { command }, cwd: root }, on);
      writeFileSync(sw, `${url}\n`);
      expect(push("git push origin main").out).toBeNull();
      expect(decision(push("git push origin feature"))).toBe("ask");
      expect(decision(push("git push --force origin main"))).toBe("deny");
      writeFileSync(sw, "https://example.test/someone-else.git\n");
      expect(decision(push("git push origin main"))).toBe("ask");
      writeFileSync(sw, "");
      expect(decision(push("git push origin main"))).toBe("ask");
      expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: root }))).toBe("ask");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies the agent any way to fake the owner's push consent or move the remote", () => {
    for (const command of ["touch ~/.config/tradeflow-kit/allow-push", "echo x > .run/allow-push", "git remote set-url origin https://example.test/x.git",
      "git remote add other https://example.test/x.git", "git config remote.origin.pushurl https://example.test/x.git", "git config core.hooksPath /tmp"]) {
      expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command } }))).toBe("deny");
    }
    for (const file_path of [`${homedir()}/.config/tradeflow-kit/allow-push`, `${root}/.run/allow-push`]) {
      expect(decision(adapter("read", { tool_name: "Write", tool_input: { file_path } }))).toBe("deny");
    }
    for (const file_path of [".git/config", ".git/hooks/pre-push", ".githooks/pre-commit", ".claude/hooks/cursor-adapter.mjs",
      ".claude/hooks/guard-shell.mjs", ".CLAUDE/hooks/guard-read.mjs", ".claude/settings.json", ".claude/settings.local.json"]) {
      expect(decision(adapter("read", { tool_name: "Edit", tool_input: { file_path: `${root}/${file_path}` } }))).toBe("deny");
    }
    expect(adapter("read", { tool_name: "Edit", tool_input: { file_path: `${root}/src/agent/guards.ts` } }).out).toBeNull();
    // upper case, and a symlinked folder that points into .git
    expect(decision(adapter("read", { tool_name: "Write", tool_input: { file_path: `${root}/.GIT/config` } }))).toBe("deny");
    const dir = mkdtempSync(path.join(tmpdir(), "claude-kit-"));
    try {
      symlinkSync(path.join(root, ".git"), path.join(dir, "g"));
      expect(decision(adapter("read", { tool_name: "Write", tool_input: { file_path: path.join(dir, "g", "hooks", "pre-push") } }))).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies a Grep over a folder named secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-kit-"));
    try {
      mkdirSync(path.join(dir, "secrets"));
      expect(decision(adapter("read", { tool_name: "Grep", tool_input: { pattern: "x", path: path.join(dir, "secrets") } }))).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies reading a symlink that points at .env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-kit-"));
    try {
      writeFileSync(path.join(dir, ".env"), "NAME=made-up\n");
      symlinkSync(path.join(dir, ".env"), path.join(dir, "notes.txt"));
      expect(decision(adapter("read", { tool_name: "Read", tool_input: { file_path: path.join(dir, "notes.txt") } }))).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies copying or linking .env", () => {
    expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command: "ln -s .env notes.txt" } }))).toBe("deny");
    expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command: "cp .env /tmp/x" } }))).toBe("deny");
    expect(adapter("shell", { tool_name: "Bash", tool_input: { command: "cp .env.example /tmp/names.txt" } }).out).toBeNull();
  });

  it("denies cat .env, asks before git push and allows ls", () => {
    expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command: "cat .env" } }))).toBe("deny");
    expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command: "git push origin main" } }))).toBe("ask");
    expect(adapter("shell", { tool_name: "Bash", tool_input: { command: "ls" } }).out).toBeNull();
  });

  it("blocks a prompt with a key and lets a normal one through", () => {
    // Built at run time so this file holds no key-like string for the pre-commit scan.
    const key = "nvapi-" + "A".repeat(24);
    expect(adapter("prompt", { prompt: `use ${key}` }).out?.decision).toBe("block");
    expect(adapter("prompt", { prompt: "add the planner" }).out).toBeNull();
  });

  it("denies shell writes to git's hooks and the kit's guards and settings, and allows reading them", () => {
    for (const command of ["echo x > .claude/hooks/guard-shell.mjs", "sed -i '' s/a/b/ .claude/settings.json", "cp /tmp/x .githooks/pre-commit",
      "rm .claude/hooks/guard-read.mjs", "tee .git/hooks/pre-push < /tmp/x", "chmod +x .git/hooks/pre-push", "git checkout -- .claude/hooks"]) {
      expect(decision(adapter("shell", { tool_name: "Bash", tool_input: { command } }))).toBe("deny");
    }
    for (const command of ["cat .claude/hooks/guard-read.mjs", "node .claude/hooks/cursor-adapter.mjs read", "git log --oneline -- .claude/hooks"]) {
      expect(adapter("shell", { tool_name: "Bash", tool_input: { command } }).out).toBeNull();
    }
  });

  it("has no Cursor kit left", () => {
    expect(existsSync(path.join(root, ".cursor"))).toBe(false);
    expect(existsSync(path.join(root, ".cursorignore"))).toBe(false);
  });

  it("exits 2 for an unknown guard", () => {
    expect(adapter("nope", {}).status).toBe(2);
  });
});
