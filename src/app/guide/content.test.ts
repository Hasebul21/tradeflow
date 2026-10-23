import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIRST_RUN, NEVER, PAGES, RUN_PAGES, WORDS } from "./content";

describe("the Guide page", () => {
  it("walks the first run in five steps, with the texts the Explain page shows", () => {
    expect(FIRST_RUN).toHaveLength(5);
    expect(FIRST_RUN.join(" ")).toContain("My week");
    expect(FIRST_RUN.join(" ")).toContain("1 Oct 2026");
    expect(FIRST_RUN.join(" ")).toContain("Why did my portfolio move this week?");
    expect(FIRST_RUN[4]).toContain('"Explain my week"');
  });

  it("lists every menu page, and links the run pages that the menu does not have", () => {
    const shell = readFileSync("src/components/ui/app-shell.tsx", "utf8");
    const menu = [...shell.matchAll(/\["(\/[^"]*)", "[^"]+"\]/g)].map((m) => m[1]);
    expect(menu).toContain("/guide");
    expect(PAGES.map((p) => p.href).sort()).toEqual([...menu].sort());
    expect(RUN_PAGES.map((p) => p.href)).toEqual(["/explain/queue", "/explain/runs", "/explain/metrics"]);
    for (const p of RUN_PAGES) expect(menu).not.toContain(p.href);
  });

  it("explains the words a result uses and gives no advice", () => {
    expect(WORDS.map((w) => w.term)).toEqual(["Round", "Citation", "needs_human", "Sample mode", "Real model"]);
    const all = JSON.stringify([FIRST_RUN, PAGES, RUN_PAGES, WORDS, NEVER]);
    expect(all).not.toMatch(/you should (buy|sell|hold)/i);
  });
});
