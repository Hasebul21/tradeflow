import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Claude Code kit in .claude/ mirrors the Cursor kit in .cursor/, so the
 * coding agent gets the same skills, rules, agents and guards in either editor.
 * If one of these fails, a kit file changed on one side only.
 */
const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");
const split = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return { front: match ? match[1] : "", body: match ? text.slice(match[0].length) : text };
};

function adapter(kind, event) {
  const run = spawnSync(process.execPath, [".claude/hooks/cursor-adapter.mjs", kind], {
    input: JSON.stringify(event),
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { status: run.status, out: run.stdout.trim() ? JSON.parse(run.stdout) : null };
}
const decision = (result) => result.out?.hookSpecificOutput?.permissionDecision ?? null;

describe("Claude Code kit mirrors the Cursor kit", () => {
  it("has every skill, word for word", () => {
    const skills = readdirSync(path.join(root, ".cursor/skills"));
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(read(`.claude/skills/${skill}/SKILL.md`)).toBe(read(`.cursor/skills/${skill}/SKILL.md`));
    }
  });

  it("has every rule with the same text and file scope", () => {
    for (const file of readdirSync(path.join(root, ".cursor/rules"))) {
      const cursor = split(read(`.cursor/rules/${file}`));
      const claude = split(read(`.claude/rules/${file.replace(/\.mdc$/, ".md")}`));
      expect(claude.body).toBe(cursor.body);
      const globs = cursor.front.match(/^globs:\s*"?([^"\n]+)"?$/m);
      if (/^alwaysApply:\s*true/m.test(cursor.front)) expect(claude.front).toBe("");
      else if (globs) {
        const paths = [...claude.front.matchAll(/^ {2}- "(.+)"$/gm)].map((m) => m[1]);
        expect(paths).toEqual(globs[1].split(",").map((glob) => glob.trim()));
      }
    }
  });

  it("has the reviewer and judge agents, read-only", () => {
    for (const file of readdirSync(path.join(root, ".cursor/agents"))) {
      const cursor = split(read(`.cursor/agents/${file}`));
      const claude = split(read(`.claude/agents/${file}`));
      expect(claude.body).toBe(cursor.body);
      expect(claude.front).toMatch(/^tools: Read, Grep, Glob, Bash$/m);
    }
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

describe("cursor-adapter.mjs", () => {
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

  it("denies reads and searches inside the folders .cursorignore hides", () => {
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

  it("exits 2 for an unknown guard", () => {
    expect(adapter("nope", {}).status).toBe(2);
  });
});
