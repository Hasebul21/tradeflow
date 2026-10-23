import { beforeAll, describe, expect, it } from "vitest";
import { requiredFindings } from "./agents/evaluator";
import { loadConfig } from "./config";
import type { Finding } from "./guards";
import { loadQueryData, type QueryData } from "./queries";
import { numbersIn } from "./guards";
import { droppedGap, dropRepeatFailures, knownSubjects, mergeRevision, passesCodeChecks, type RevisionInput } from "./revision";
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

  it("leaves out a retracted finding, restores a retracted one the coverage check requires with a gap, and asks again for a flagged one", async () => {
    const { run, moves } = await week();
    const renata = finding("move", "RENATA", [moves], "RENATA fell 3.7% over the week.", [{ value: -3.74, label: "change %" }]);
    const bxpharma = finding("move", "BXPHARMA", [moves], "BXPHARMA fell 14.9% over the week.", [{ value: -14.88, label: "change %" }]);
    const retracted = [
      { kind: "move", subject: "RENATA", why: "in line with its sector" },
      { kind: "move", subject: "BXPHARMA", why: "covered elsewhere" },
    ];

    const known = knownSubjects(d.portfolio.instruments.values(), run.store);
    const result = merge(run, { previous: [renata, bxpharma], next: [], retracted, known });
    expect(result.findings).toEqual([bxpharma]);
    expect(result.kept).toEqual([expect.objectContaining({ finding: bxpharma, how: "restored", why: expect.stringMatching(/largest move.*the Analyst retracted it/) })]);
    // The review says code kept it; the Analyst's reason is model text, so it stays out of this trusted gap.
    expect(result.notes).toEqual([
      { key: "move\u0000BXPHARMA", gap: "The Analyst withdrew its move finding on BXPHARMA; it is kept unchanged because the coverage check requires it.", finding: bxpharma, kind: "kept_despite_retraction" },
    ]);
    expect(result.notes[0].gap).not.toContain("covered elsewhere");

    // A required finding the last fix flagged is not put back unchanged: the coverage check asks for it again.
    const named = merge(run, { previous: [renata, bxpharma], flagged: new Set([bxpharma]), next: [] });
    expect(named.findings).toEqual([renata]);
    expect(named.kept.map((entry) => [entry.finding.subject, entry.how])).toEqual([["RENATA", "carried"]]);
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
    expect(result).toEqual({ findings: [], kept: [], notes: [] });
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

  it("drops a flagged finding that comes back still failing, unless it is the only one coverage needs", async () => {
    const { run, moves } = await week();
    const sectors = await run.query("sector_vs_stock", { as_of: AS_OF, sessions: 5 });
    const required = requiredFindings("explain_week", run.store, AS_OF);
    const sectorEight = () => finding("sector", "Pharmaceuticals & Chemicals", [sectors.run_query_id], "The sector fell 2.99%, 2.2 points behind DSEX.", [{ value: -2.99, label: "change %" }]);
    const badBxpharma = () => finding("move", "BXPHARMA", [moves], "BXPHARMA fell 14.9% over the week.", [{ value: 98765.4, label: "made-up" }]);
    const portfolio = finding("move", "PORTFOLIO", [moves], "The data shows the portfolio fell 1.7% over the week.", [{ value: -1.67, label: "change %" }]);
    const flagged = new Set([sectorEight(), badBxpharma()]);
    const known = knownSubjects(d.portfolio.instruments.values(), run.store);

    const again = [portfolio, sectorEight(), badBxpharma()];
    const result = dropRepeatFailures({ task: "explain_week", flagged, findings: again, required, store: run.store, known });
    // The sector finding goes, with a gap; BXPHARMA stays, because it is the only finding on the largest move.
    expect(result.findings).toEqual([portfolio, again[2]]);
    expect(result.dropped).toEqual([{ finding: again[1], gap: "The sector finding on Pharmaceuticals & Chemicals was left out: after the Evaluator's fix it still used figures that no cited row of this run holds." }]);

    // A first failure is never dropped, and a fixed one passes and stays.
    expect(dropRepeatFailures({ task: "explain_week", flagged: new Set(), findings: again, required, store: run.store, known }).dropped).toEqual([]);
    const fixed = { ...sectorEight(), claim: "The sector fell 2.99%, 2.25 points behind DSEX." };
    expect(dropRepeatFailures({ task: "explain_week", flagged, findings: [portfolio, fixed], required, store: run.store, known }).findings).toEqual([portfolio, fixed]);
  });

  it("writes a dropped finding's gap from validated names only, so a model-chosen subject never adds a figure", async () => {
    const { run, moves } = await week();
    const known = knownSubjects(d.portfolio.instruments.values(), run.store);
    expect(known.has("BXPHARMA") && known.has("Pharmaceuticals & Chemicals")).toBe(true);
    const of = (kind: string, subject: string) => finding(kind, subject, [moves], "The data shows a move.");

    // A subject carrying a number, or any subject that is not exactly a known symbol or sector, is not named.
    for (const subject of ["BXPHARMA 99.9", "bxpharma", "BXPHARMA ", "j-026 at 99.9%", "Pharma 99.9"]) {
      const gap = droppedGap(of("move", subject), known);
      expect(gap).toBe("A flagged finding was left out: after the Evaluator's fix it still used figures that no cited row of this run holds.");
      expect(numbersIn(gap)).toEqual([]);
    }
    // A kind outside the nine is model text too.
    expect(droppedGap(of("move 99.9", "BXPHARMA"), known)).toMatch(/^A flagged finding was left out/);
    // A valid symbol or sector, with a valid kind, is named.
    expect(droppedGap(of("move", "BXPHARMA"), known)).toBe("The move finding on BXPHARMA was left out: after the Evaluator's fix it still used figures that no cited row of this run holds.");
    expect(droppedGap(of("sector", "Pharmaceuticals & Chemicals"), known)).toMatch(/^The sector finding on Pharmaceuticals & Chemicals was left out/);
  });

  it("reads a run-dated day range as dates, as the Evaluator does: such a finding is carried, and not dropped", async () => {
    // The run's as_of is 17 Sept; the cited query's window starts on 11 Sept. Only as_of makes 17 a date of the run.
    const run = new RunState({ runId: "t", tracer, config, sampleMode: true, data: d });
    const announcements = await run.query("announcements_between", { from: "2026-09-11", to: "2026-09-16" });
    const ranged = finding("announcement", "PORTFOLIO", [announcements.run_query_id], "The data shows the announcements over 11-17 Sept 2026.");
    const asOf = "2026-09-17";
    expect(passesCodeChecks(ranged, "explain_week", run.store)).toBe(false);
    expect(passesCodeChecks(ranged, "explain_week", run.store, [], asOf)).toBe(true);

    const input = { task: "explain_week" as const, previous: [ranged], flagged: new Set<Finding>(), next: [], retracted: [], required: [], store: run.store };
    expect(mergeRevision({ ...input, asOf }).findings).toEqual([ranged]);
    expect(mergeRevision(input).findings).toEqual([]);

    const known = knownSubjects(d.portfolio.instruments.values(), run.store);
    const flagged = new Set([{ ...ranged }]);
    expect(dropRepeatFailures({ task: "explain_week", flagged, findings: [ranged], required: [], store: run.store, known, asOf }).dropped).toEqual([]);
    expect(dropRepeatFailures({ task: "explain_week", flagged, findings: [ranged], required: [], store: run.store, known }).dropped).toHaveLength(1);
  });

  it("names the check a dropped finding failed in its gap", async () => {
    const { run, moves } = await week();
    const known = knownSubjects(d.portfolio.instruments.values(), run.store);
    const advice = finding("move", "GP", [moves], "You should sell GP now.");
    const flagged = new Set([{ ...advice }]);
    const result = dropRepeatFailures({ task: "explain_week", flagged, findings: [advice], required: [], store: run.store, known });
    expect(result.dropped.map((gone) => gone.gap)).toEqual(["The move finding on GP was left out: after the Evaluator's fix the reply guard still refused it (advice, or a finding that breaks the schema)."]);
  });

  it("matches previous findings with the same kind and subject by count, so a surplus one is carried", async () => {
    const { run, rules } = await week();
    const first = finding("rule", "Pharmaceuticals & Chemicals", [rules], "The data shows Pharmaceuticals & Chemicals is 37.8% of the portfolio.", [{ value: 37.8, label: "weight %" }]);
    const second = finding("rule", "Pharmaceuticals & Chemicals", [rules], "The data shows Pharmaceuticals & Chemicals is 7.8 points over its target.", [{ value: 7.8, label: "points over" }]);
    const rewritten = { ...first, claim: "The data shows Pharmaceuticals & Chemicals is 37.8% of the portfolio against a 30% target." };
    const result = merge(run, { previous: [first, second], next: [rewritten] });
    expect(result.findings).toEqual([rewritten, second]);
    expect(result.kept).toEqual([expect.objectContaining({ finding: second, how: "carried" })]);
    expect(merge(run, { previous: [first, second], next: [rewritten, { ...second }] }).kept).toEqual([]);
  });
});
