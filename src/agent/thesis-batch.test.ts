import { describe, expect, it } from "vitest";
import { findingsOfBatch } from "./thesis";

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
