import { describe, expect, it } from "vitest";
import { findingsOfBatch, withNamedRows } from "./thesis";

const batch = [{ journal_id: "j-006" }, { journal_id: "j-007" }, { journal_id: "j-008" }, { journal_id: "j-009" }, { journal_id: "j-010" }];
const thesis = (subject: string) => ({ kind: "thesis", subject });

describe("findingsOfBatch", () => {
  it("keeps the batch's own thesis findings and drops thesis findings for other theses", () => {
    // 24 Oct, example_5: a batch of 5 theses came back with 11 findings, six of them for other batches' theses.
    const reply = [..."678".split("").map((n) => thesis(`j-00${n}`)), thesis("j-009"), thesis("j-010"), ...[11, 12, 13, 14, 15, 16].map((n) => thesis(`j-0${n}`))];
    const { kept, dropped } = findingsOfBatch(batch, reply);
    expect(reply).toHaveLength(11);
    expect(kept.map((finding) => finding.subject)).toEqual(["j-006", "j-007", "j-008", "j-009", "j-010"]);
    expect(dropped.map((finding) => finding.subject)).toEqual(["j-011", "j-012", "j-013", "j-014", "j-015", "j-016"]);
  });

  it("keeps the first thesis finding for a thesis and drops the repeats", () => {
    // 24 Oct, example_5: a batch of 5 theses came back with 20 findings.
    const reply = ["j-006", "j-006", "j-007", "j-007", "j-007", "j-008"].map(thesis);
    const { kept, dropped } = findingsOfBatch(batch, reply);
    expect(kept.map((finding) => finding.subject)).toEqual(["j-006", "j-007", "j-008"]);
    expect(dropped).toHaveLength(3);
  });

  it("keeps a finding of another kind whatever its subject", () => {
    const move = { kind: "move", subject: "PORTFOLIO" };
    expect(findingsOfBatch(batch, [thesis("j-006"), move])).toEqual({ kept: [thesis("j-006"), move], dropped: [] });
  });

  it("drops nothing from a reply that stays in its batch, and handles an empty reply", () => {
    expect(findingsOfBatch(batch, [thesis("j-010")]).dropped).toEqual([]);
    expect(findingsOfBatch(batch, [])).toEqual({ kept: [], dropped: [] });
  });
});

describe("withNamedRows", () => {
  const WEEK = "4c9610f5-e741-4f0f-86fc-e004b242a1c8";
  const DIVS = "e716f7d8-e319-4a6a-8ef8-02ffd5769f08";
  const ANN = "b8d256f3-5bcd-4a9c-92a5-0372ccd5da48";
  const store = new Set([WEEK, DIVS, ANN, "97d85ff5-8623-4862-bf94-c2b7271006ca"]);
  // 24 Oct, example_5: the fix text the Evaluator sent for finding 5 (j-026) and finding 26 (j-001).
  const fix = `Fix finding 5 (thesis j-026): the number 25.44 (weight pct) is not in the cited rows (25.44 is in week_moves ${WEEK}: cite the one it came from, or leave it out); use only figures from the rows it cites. Fix finding 26 (thesis j-001): the number 12.5 (dividend per share (Tk)) is not in the cited rows (12.5 is in announcements_between ${ANN} and dividends_between ${DIVS}: cite the one it came from, or leave it out); use only figures from the rows it cites.`;

  it("adds the row ids the fix names for a finding of the same kind and subject, once", () => {
    const j026 = { kind: "thesis", subject: "j-026", cites: ["97d85ff5-8623-4862-bf94-c2b7271006ca"] };
    const j001 = { kind: "thesis", subject: "j-001", cites: ["97d85ff5-8623-4862-bf94-c2b7271006ca"] };
    const [a, b] = withNamedRows([j026, j001], fix, store);
    expect(a.cites).toEqual(["97d85ff5-8623-4862-bf94-c2b7271006ca", WEEK]);
    expect(b.cites).toEqual(["97d85ff5-8623-4862-bf94-c2b7271006ca", ANN, DIVS]);
  });

  it("leaves a finding alone when the fix names no row for it, and ignores ids that are not rows of this run", () => {
    const other = { kind: "thesis", subject: "j-099", cites: ["x"] };
    expect(withNamedRows([other], fix, store)).toEqual([other]);
    const unknown = `Fix finding 1 (thesis j-026): 1 is in fundamentals_latest 00000000-0000-4000-8000-000000000000.`;
    const j026 = { kind: "thesis", subject: "j-026", cites: ["x"] };
    expect(withNamedRows([j026], unknown, store)).toEqual([j026]);
  });

  it("returns the findings unchanged when there is no fix", () => {
    const j026 = { kind: "thesis", subject: "j-026", cites: ["x"] };
    expect(withNamedRows([j026], null, store)).toEqual([j026]);
  });
});
