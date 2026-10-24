import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", async (importOriginal) => (await import("../render-for-tests")).inlinePopups(await importOriginal()));
vi.mock("next/navigation", async () => (await import("../render-for-tests")).navigation("/guide"));

import { AppShell } from "@/components/ui/app-shell";
import { html, render } from "../render-for-tests";
import { FIRST_RUN, NEVER } from "./content";
import GuidePage from "./page";

/** The page's text with the tags taken out, as a reader sees it. */
const plain = (markup: string) =>
  markup.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every page address in the main menu, read from the menu's source: antd draws submenus only when opened. */
const menuHrefs = () => [...readFileSync("src/components/ui/app-shell.tsx", "utf8").matchAll(/\["(\/[^"]*)", "[^"]+"\]/g)].map((m) => m[1]);

describe("the Guide page", () => {
  const page = render(<GuidePage />);

  it("renders the five first-run steps in order, with the names the app uses", () => {
    expect(FIRST_RUN).toHaveLength(5);
    const text = plain(page);
    let at = 0;
    for (const step of FIRST_RUN) {
      const found = text.indexOf(step, at);
      expect(found, step).toBeGreaterThanOrEqual(at);
      at = found + step.length;
    }
    expect(text).toContain('Press "Explain my week"');
    expect(text).toContain("Set the date to 1 Oct 2026.");
    expect(text).toContain('"Why did my portfolio move this week?"');
    expect(page).toContain('data-testid="first-run"');
  });

  it("links every menu page, and the review queue, past runs and metrics", () => {
    const hrefs = menuHrefs();
    expect(hrefs.length).toBeGreaterThanOrEqual(14);
    for (const href of [...hrefs, "/explain/queue", "/explain/runs", "/explain/metrics"]) expect(page).toContain(`href="${href}"`);
  });

  it("links page names inside its sentences, but not the button Explain my week", () => {
    expect(page).toContain('<span>Open </span><a href="/explain">Analysis &amp; Verification</a><span> from the menu.</span>');
    expect(page).toContain('<a href="/explain/queue">Pending Approvals</a><span> page lists these runs.</span>');
    expect(page).toContain(html('Press "Explain my week"'));
  });

  it("ends with an Alert on what it never does", () => {
    expect(page).toContain('data-testid="never"');
    expect(page).toContain("ant-alert");
    expect(page).toContain(NEVER);
  });

  it("is in the main menu as Guide, after the other items, linking to /guide", () => {
    const shell = render(<AppShell>page</AppShell>);
    expect(shell).toContain('<a href="/guide">Guide</a>');
    const labels = [...shell.matchAll(/<a href="[^"]*">([^<]+)<\/a>|>(Market|Records)</g)].map((m) => m[1] ?? m[2]).filter((l) => l !== "Tradeflow");
    expect(labels[labels.length - 1]).toBe("Guide");
  });
});
