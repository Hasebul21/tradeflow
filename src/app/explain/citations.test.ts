import { describe, expect, it } from "vitest";
import type { Citation } from "@/agent/orchestrator";
import { splitCitations } from "./citations";

const citation = (run_query_id: string): Citation => ({ run_query_id, query_id: "week_moves", params: {}, source: "local", row_count: 0, rows: [] });

describe("splitCitations", () => {
  it("turns [q:abc-123] into one link whose target is citation abc-123", () => {
    const abc = citation("abc-123");
    const parts = splitCitations("The portfolio fell [q:abc-123] on Thursday.", [abc, citation("other")]);
    expect(parts.filter((p) => p.kind === "cite")).toEqual([{ kind: "cite", id: "abc-123", citation: abc }]);
    expect(parts.map((p) => (p.kind === "text" ? p.text : "")).join("")).toBe("The portfolio fell  on Thursday.");
  });

  it("leaves a marker with no matching citation as text", () => {
    const parts = splitCitations("See [q:nope].", [citation("abc-123")]);
    expect(parts).toEqual([{ kind: "text", text: "See [q:nope]." }]);
  });
});
