// The texts and selectors the demo video recorder and the tests click on. Each must still render on its page.
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", async (importOriginal) => (await import("./render-for-tests")).inlinePopups(await importOriginal()));
vi.mock("next/navigation", async () => (await import("./render-for-tests")).navigation("/"));

import { citation, PROOF, RANGE, result, state } from "./explain/fixtures-for-tests";
import { CitationDrawer, ExplainView, Live, PreTradeTab, ProofRow, Result, ThesesTab, WeekTab } from "./explain/view";
import PortfolioPage from "./page";
import { render } from "./render-for-tests";

describe("protected texts and selectors", () => {
  it("the Explain page's buttons and tabs", () => {
    const week = render(<WeekTab range={RANGE} />);
    expect(week).toContain("<span>Explain my week</span>");
    expect(week).toContain(">Why did my portfolio move this week?<");
    expect(week).toContain(">Should I sell BXPHARMA now?<");
    expect(render(<ThesesTab range={RANGE} theses={{}} />)).toContain("<span>Check</span>");
    expect(render(<PreTradeTab range={RANGE} plans={[]} />)).toContain("<span>Check this trade</span>");
    const tabs = render(<ExplainView range={RANGE} theses={{}} plans={[]} sampleMode={false} />);
    expect(tabs).toContain(">Theses<");
    expect(tabs).toContain(">Pre-trade<");
  });

  it("a run's live card, result, proof cards and citation drawer", () => {
    expect(render(<Live state={state(null, { running: true, started: false, runId: "run-1" })} onStop={() => {}} />)).toContain(">Working<");
    const done = render(<Result state={state(result({}, { declined_advice: true }))} />);
    for (const text of [">Trace (JSON)<", "Steps (", ">Scores<", ">Advice declined<"]) expect(done).toContain(text);
    const escalated = render(<Result state={state(result({ status: "needs_human" }, { escalation: { rule: "sector_target", message: "Engineering would be above its target." } as never }))} />);
    expect(escalated).toContain("Nothing has been saved");
    const cards = render(<ProofRow proof={PROOF} />);
    for (const id of ["proof-zetaris", "proof-meterless", "proof-nemotron", "proof-guards"]) expect(cards).toContain(`data-testid="${id}"`);
    expect(render(<CitationDrawer citation={citation({ source: "zetaris", sql: "SELECT 1" })} onClose={() => {}} />)).toContain("SQL that Zetaris ran");
  });

  it("the Portfolio page's attribution card", async () => {
    const page = render(await PortfolioPage({ searchParams: Promise.resolve({}) }));
    expect(page).toContain("What moved the portfolio this week");
    expect(page).toContain("The portfolio moved");
  });
});
