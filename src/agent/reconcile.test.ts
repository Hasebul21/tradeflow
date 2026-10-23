import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DISCLAIMER } from "./agents/writer";
import { loadConfig } from "./config";
import { run, type RunResult } from "./orchestrator";
import { loadQueryData, runLocal } from "./queries";
import { APPROVE_REFUSED, canApply, editFor, nextId, proposedFix, reconcilePlan, ZETARIS_STALE } from "./reconcile-fix";
import type { TraceLine } from "./trace";

// reconcile as of 2026-10-01 with the sample model, then reconcile_approve, each on a temporary copy of data/
// through TRADEFLOW_DATA_DIR. The repo's own data/ is never written: the refusal tests hash it before and after.
const config = loadConfig({ SAMPLE_MODE: "true" }, () => {});
const AS_OF = "2026-10-01";
const ISSUES = ["BNK-0008", "BRK-20260802-035", "t-030", "t-021"];

const trace = (result: RunResult): TraceLine[] =>
  readFileSync(path.resolve(result.log_file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);

const hashOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const LEDGER_FILES = ["data/contributions.json", "data/transactions.json"].map((file) => path.resolve(file));

let dir: string;
let review: RunResult;
const savedDir = process.env.TRADEFLOW_DATA_DIR;
const savedEnv = process.env.NODE_ENV;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-reconcile-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  review = await run({ runId: "reconcile-review", task: "reconcile", input: { as_of: AS_OF }, sampleMode: true, config });
}, 60_000);

afterEach(() => {
  process.env.TRADEFLOW_DATA_DIR = dir;
  (process.env as Record<string, string | undefined>).NODE_ENV = savedEnv;
});

afterAll(async () => {
  if (savedDir === undefined) delete process.env.TRADEFLOW_DATA_DIR;
  else process.env.TRADEFLOW_DATA_DIR = savedDir;
  await rm(dir, { recursive: true, force: true });
});

describe("reconcile, sample model", () => {
  it("as of 2026-10-01 gives exactly four proposals, each awaiting approval, and needs_human", () => {
    expect(review.status).toBe("needs_human");
    expect(review.error).toBeNull();
    const proposals = review.output!.proposals!;
    expect(proposals.map((p) => p.issue_id).sort()).toEqual([...ISSUES].sort());
    expect(proposals.every((p) => p.status === "awaiting_approval")).toBe(true);
    expect(review.output!.stop_reason).toBeNull();
    expect(review.output!.partial).toBe(false);
  });

  it("builds each proposed fix in code, in the form for its kind", () => {
    const fixes = Object.fromEntries(review.output!.proposals!.map((p) => [p.issue_id, p.proposed_fix]));
    expect(fixes["BNK-0008"]).toBe("add a contribution of Tk 25000 on 2026-07-23 (BNK-0008)");
    expect(fixes["BRK-20260802-035"]).toBe("add a transaction of buy 20 OLYMPIC at Tk 163.6 on 2026-08-02 (BRK-20260802-035)");
    expect(fixes["t-021"]).toBe("manual check: commission_bdt differs between ledger t-021 and broker BRK-20260512-021");
    expect(fixes["t-030"]).toBe("manual check: ledger trade t-030 has no broker row");
  });

  it("has one reconciliation finding per issue, each saying the reason is not known", () => {
    const findings = review.output!.findings.filter((f) => f.kind === "reconciliation");
    expect(findings.map((f) => f.subject).sort()).toEqual([...ISSUES].sort());
    expect(findings.every((f) => f.claim.includes(f.subject!) && /Reason: not known/.test(f.claim))).toBe(true);
  });

  it("is a fixed chain: Orchestrator fixed_plan, no Planner call, journals only for the traded symbols", () => {
    const lines = trace(review);
    expect(lines.some((l) => l.agent_name === "Orchestrator" && l.action === "fixed_plan")).toBe(true);
    expect(lines.some((l) => l.agent_name === "Planner")).toBe(false);
    const branch = lines.find((l) => l.agent_name === "Orchestrator" && l.action === "branch")!;
    expect(branch.output_summary).toMatch(/journal_for_symbol EBL, journal_for_symbol LHBL, journal_for_symbol OLYMPIC/);
  });

  it("summarises the proposals in words and ends the review with the disclaimer", () => {
    expect(review.output!.summary).toMatch(/four differences have proposed fixes awaiting your approval\. Nothing has been saved; the decision is yours\./);
    expect(review.output!.review_markdown.trimEnd().split("\n").at(-1)).toBe(DISCLAIMER);
  });
});

describe("reconcile_approve", () => {
  it("applies BNK-0008 on the copy: one contribution added, then three issues", async () => {
    const before = JSON.parse(readFileSync(path.join(dir, "contributions.json"), "utf8")) as unknown[];
    const approved = await run({ runId: "reconcile-approve-bnk", task: "reconcile_approve", input: { review_run_id: review.run_id, issue_id: "BNK-0008" }, sampleMode: true, config });
    expect(approved.status).toBe("success");
    expect(approved.output!.applied!.edit.op).toBe("add_contribution");
    expect(approved.output!.summary).toContain(ZETARIS_STALE);
    const after = JSON.parse(readFileSync(path.join(dir, "contributions.json"), "utf8")) as { id: string; amount_bdt: number }[];
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toMatchObject({ id: "c-10", amount_bdt: 25000 });
    const issues = runLocal("reconciliation", {}, await loadQueryData()).rows.map((row) => row.issue_id);
    expect(issues.sort()).toEqual(["BRK-20260802-035", "t-021", "t-030"]);

    const lines = trace(approved);
    expect(lines.some((l) => l.agent_name === "Query" && l.source === "local" && l.input_summary.startsWith("reconciliation"))).toBe(true);
    expect(lines.some((l) => l.agent_name === "Orchestrator" && l.action === "approval" && l.status === "ok")).toBe(true);
    expect(lines.some((l) => l.agent_name === "Guard" && /beforeRemember kind=decision/.test(l.input_summary) && l.status === "ok")).toBe(true);
    expect(approved.output!.applied!.memory_id).not.toBeNull();
  });

  it("changes nothing when the same issue is approved again", async () => {
    const before = hashOf(path.join(dir, "contributions.json"));
    const again = await run({ runId: "reconcile-approve-again", task: "reconcile_approve", input: { review_run_id: review.run_id, issue_id: "BNK-0008" }, sampleMode: true, config });
    expect(again.status).toBe("error");
    expect(again.error!.message).toMatch(/not an open difference/);
    expect(hashOf(path.join(dir, "contributions.json"))).toBe(before);
  });

  it("writes the broker trade with its commission as fees_bdt, so it then matches with no fee difference", async () => {
    const approved = await run({ runId: "reconcile-approve-brk", task: "reconcile_approve", input: { review_run_id: review.run_id, issue_id: "BRK-20260802-035" }, sampleMode: true, config });
    expect(approved.status).toBe("success");
    expect(approved.output!.applied!.edit).toMatchObject({ op: "add_transaction", row: { id: "t-046", symbol: "OLYMPIC", side: "buy", quantity: 20, price_per_share: 163.6, fees_bdt: 13.09 } });
    const issues = runLocal("reconciliation", {}, await loadQueryData()).rows.map((row) => row.issue_id);
    expect(issues.sort()).toEqual(["t-021", "t-030"]);
  });

  it("shows a commission difference as a manual check and writes nothing", async () => {
    const before = hashOf(path.join(dir, "transactions.json"));
    const checked = await run({ runId: "reconcile-approve-t021", task: "reconcile_approve", input: { review_run_id: review.run_id, issue_id: "t-021" }, sampleMode: true, config });
    expect(checked.status).toBe("needs_human");
    expect(checked.output!.summary).toMatch(/manual check: commission_bdt differs/);
    expect(hashOf(path.join(dir, "transactions.json"))).toBe(before);
  });

  it.each([
    ["unset", undefined],
    ["./data", "./data"],
  ])("with TRADEFLOW_DATA_DIR %s and NODE_ENV not production, returns needs_human and writes nothing", async (_label, value) => {
    if (value === undefined) delete process.env.TRADEFLOW_DATA_DIR;
    else process.env.TRADEFLOW_DATA_DIR = value;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    const before = LEDGER_FILES.map(hashOf);
    const refused = await run({ runId: `reconcile-approve-refused-${value === undefined ? "unset" : "data"}`, task: "reconcile_approve", input: { review_run_id: review.run_id, issue_id: "BNK-0008" }, sampleMode: true, config });
    expect(refused.status).toBe("needs_human");
    expect(refused.output!.summary).toContain(APPROVE_REFUSED);
    expect(refused.output!.applied).toBeNull();
    expect(LEDGER_FILES.map(hashOf)).toEqual(before);
    expect(trace(refused).some((l) => l.action === "approval_refused")).toBe(true);
  });

  it("refuses a request without issue_id as InvalidInput", async () => {
    const missing = await run({ runId: "reconcile-approve-missing", task: "reconcile_approve", input: { review_run_id: review.run_id }, sampleMode: true, config });
    expect(missing.status).toBe("error");
    expect(missing.error).toMatchObject({ type: "InvalidInput" });
  });
});

describe("reconcile-fix helpers", () => {
  it("canApply: production, or a data dir that is not the repo's data/", () => {
    expect(canApply({ NODE_ENV: "production" })).toBe(true);
    expect(canApply({ TRADEFLOW_DATA_DIR: "/tmp/copy" })).toBe(true);
    expect(canApply({})).toBe(false);
    expect(canApply({ TRADEFLOW_DATA_DIR: "./data" })).toBe(false);
    expect(canApply({ TRADEFLOW_DATA_DIR: path.resolve("data") })).toBe(false);
  });

  it("nextId pads the next number", () => {
    expect(nextId("t", ["t-009", "t-045", "bonus-ca-04"], 3)).toBe("t-046");
    expect(nextId("c", [], 2)).toBe("c-01");
  });

  it("reconcilePlan keeps reconciliation first and cuts journals at the step limit", () => {
    const rows = [
      { issue_id: "t-1", kind: "ledger_only_trade", symbol: "BBB" },
      { issue_id: "t-2", kind: "mismatched_trade", symbol: "AAA" },
      { issue_id: "BNK-1", kind: "bank_only_deposit", symbol: null },
    ];
    const plan = reconcilePlan(rows, AS_OF, 2);
    expect(plan.steps.map((s) => s.query_id)).toEqual(["reconciliation", "journal_for_symbol"]);
    expect(plan.steps[1].params).toEqual({ as_of: AS_OF, symbol: "AAA" });
    expect(plan.left_out).toEqual(["BBB"]);
  });

  it("editFor writes nothing for a contribution with no bank deposit", () => {
    const edit = editFor({ issue_id: "c-03", kind: "contribution_only_deposit", ledger_id: "c-03", amount_bdt: 10 }, { transactionIds: [], contributionIds: [] });
    expect(edit).toEqual({ op: "manual_check", reason: proposedFix({ issue_id: "c-03", kind: "contribution_only_deposit", ledger_id: "c-03" }) });
  });
});
