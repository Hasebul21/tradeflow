import { beforeAll, describe, expect, it } from "vitest";
import { requiredFindings } from "./agents/evaluator";
import { loadConfig } from "./config";
import type { Finding } from "./guards";
import { loadQueryData, type QueryData } from "./queries";
import { mergeRevision, passesCodeChecks, type RevisionInput } from "./revision";
import { RunState } from "./run-state";
import type { Tracer } from "./trace";

// The seed data in data/ and a run state whose tracer keeps nothing: mergeRevision is pure, so no trace is written.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

const config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const tracer = { log: (line: unknown) => line } as unknown as Tracer;

async function week() {
  const run = new RunState({ runId: "t", tracer, config, sampleMode: true, data: d });
  const moves = await run.query("week_moves", { as_of: AS_OF, sessions: 5 });
  const rules = await run.query("rule_findings", { as_of: AS_OF });
  return { run, moves: moves.run_query_id, rules: rules.run_query_id };
}

const finding = (kind: string, subject: string, cites: string[], claim: string, numbers: Finding["numbers"] = []): Finding => ({
  kind,
  subject,
  claim,
  numbers,
  cites,
  verdict: null,
  proposed_fix: null,
  memory_ids: [],
});

function merge(run: RunState, input: Omit<RevisionInput, "task" | "store" | "required" | "flagged" | "retracted"> & Partial<RevisionInput>) {
  return mergeRevision({ task: "explain_week", store: run.store, required: requiredFindings("explain_week", run.store, AS_OF), flagged: new Set(), retracted: [], ...input });
}

describe("mergeRevision: revise, don't restart", () => {
  it("carries an unflagged finding the new draft left out back to its previous place, and never a flagged one", async () => {
    const { run, moves, rules } = await week();
    const portfolio = finding("move", "PORTFOLIO", [moves], "The data shows the portfolio fell 1.7% over the week.", [{ value: -1.67, label: "change %" }]);
    const renata = finding("move", "RENATA", [moves], "RENATA fell 3.7% over the week.", [{ value: -3.74, label: "change %" }]);
    const bxpharma = finding("move", "BXPHARMA", [moves], "BXPHARMA fell 14.9% over the week.", [{ value: -14.88, label: "change %" }]);
    const rule = finding("rule", "SQURPHARMA", [rules], "SQURPHARMA is 25.4% of the portfolio.", [{ value: 25.4, label: "weight %" }]);
    const previous = [portfolio, renata, bxpharma, rule];
    const rewritten = { ...rule, claim: "The data shows SQURPHARMA is 25.4% of the portfolio, above the 25% limit." };

    const result = merge(run, { previous, flagged: new Set([renata]), next: [portfolio, bxpharma, rewritten] });

    // RENATA was flagged, so it stays out; SQURPHARMA's rule finding is replaced by the new one with the same kind and subject.
    expect(result.findings).toEqual([portfolio, bxpharma, rewritten]);
    expect(result.kept).toEqual([]);

    const dropped = merge(run, { previous, next: [portfolio, rewritten] });
    expect(dropped.findings.map((f) => f.subject)).toEqual(["PORTFOLIO", "RENATA", "BXPHARMA", "SQURPHARMA"]);
    expect(dropped.kept).toEqual([
      expect.objectContaining({ finding: renata, was: 2, how: "carried" }),
      expect.objectContaining({ finding: bxpharma, was: 3, how: "restored", why: expect.stringContaining("BXPHARMA is the largest move of the week") }),
    ]);
  });

  it("leaves out a retracted finding, but restores a retracted or fix-named one the coverage check requires", async () => {
    const { run, moves } = await week();
    const renata = finding("move", "RENATA", [moves], "RENATA fell 3.7% over the week.", [{ value: -3.74, label: "change %" }]);
    const bxpharma = finding("move", "BXPHARMA", [moves], "BXPHARMA fell 14.9% over the week.", [{ value: -14.88, label: "change %" }]);
    const retracted = [
      { kind: "move", subject: "RENATA", why: "in line with its sector" },
      { kind: "move", subject: "BXPHARMA", why: "covered elsewhere" },
    ];

    const result = merge(run, { previous: [renata, bxpharma], next: [], retracted });
    expect(result.findings).toEqual([bxpharma]);
    expect(result.kept).toEqual([expect.objectContaining({ finding: bxpharma, how: "restored", why: expect.stringMatching(/largest move.*the Analyst retracted it/) })]);

    const named = merge(run, { previous: [renata, bxpharma], flagged: new Set([bxpharma]), next: [] });
    expect(named.findings).toEqual([renata, bxpharma]);
    expect(named.kept.map((entry) => [entry.finding.subject, entry.how])).toEqual([
      ["RENATA", "carried"],
      ["BXPHARMA", "restored"],
    ]);
  });

  it("never carries or restores a finding that fails the code checks, so no refused number gets back in", async () => {
    const { run, moves } = await week();
    // The 23 Oct example_2 finding 8: -2.25 written as 2.2 and -7259.4 as 7259; and a made-up BXPHARMA figure.
    const sectors = await run.query("sector_vs_stock", { as_of: AS_OF, sessions: 5 });
    const sector = finding("sector", "Pharmaceuticals & Chemicals", [sectors.run_query_id], "The sector fell 2.99%, 2.2 points behind DSEX, costing Tk 7259.", [{ value: -2.99, label: "change %" }]);
    const bxpharma = finding("move", "BXPHARMA", [moves], "BXPHARMA fell 14.9% over the week.", [{ value: 98765.4, label: "made-up" }]);
    expect(passesCodeChecks(sector, "explain_week", run.store)).toBe(false);
    expect(passesCodeChecks(bxpharma, "explain_week", run.store)).toBe(false);

    const result = merge(run, { previous: [sector, bxpharma], next: [] });
    expect(result).toEqual({ findings: [], kept: [] });
  });

  it("restores one thesis finding per missing journal id, and never a second for an id the new draft covers", async () => {
    const run = new RunState({ runId: "t", tracer, config, sampleMode: true, data: d });
    const journal = await run.query("journal_for_symbol", { as_of: AS_OF, symbol: "GP" });
    const ids = journal.rows.map((row) => String(row.id));
    expect(ids.length).toBeGreaterThan(0);
    const thesis = (id: string, verdict: string) => ({ ...finding("thesis", id, [journal.run_query_id], `Open: the data shows nothing yet on ${id}.`), verdict });
    const previous = ids.map((id) => thesis(id, "open"));
    const next = [thesis(ids[0], "confirmed")];

    const result = mergeRevision({ task: "thesis_check", previous, flagged: new Set(), next, retracted: [], required: requiredFindings("thesis_check", run.store, AS_OF), store: run.store });
    expect(result.findings.filter((f) => f.subject === ids[0])).toEqual([next[0]]);
    expect(result.findings.map((f) => f.subject).sort()).toEqual([...ids].sort());
    expect(result.kept.every((entry) => entry.how === "restored")).toBe(true);
  });
});
