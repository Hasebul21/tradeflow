import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQueryData, runLocal, type QueryResult } from "./queries";
import { about, openWorld, recordRun } from "./world";

// Each test gets its own copy of data/ through TRADEFLOW_DATA_DIR, so the World Model lives in its memory/world.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-world-"));
  await cp(path.resolve("data"), dir, { recursive: true, filter: (source) => path.basename(source) !== "memory" });
  process.env.TRADEFLOW_DATA_DIR = dir;
  process.env.SAMPLE_MODE = "true";
});

afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  delete process.env.SAMPLE_MODE;
  await rm(dir, { recursive: true, force: true });
});

async function results1001(): Promise<Record<string, QueryResult>> {
  const data = await loadQueryData();
  const list = [
    runLocal("week_moves", { as_of: "2026-10-01" }, data),
    runLocal("announcements_between", { from: "2026-09-24", to: "2026-10-01" }, data),
    runLocal("fundamentals_latest", { symbol: "BXPHARMA", as_of: "2026-10-01" }, data),
  ];
  return Object.fromEntries(list.map((result) => [result.run_query_id, result]));
}

describe("world", () => {
  it("records the 1 Oct results and lists a-066 and latest_eps 1.62 for BXPHARMA, each with its run_query_id", async () => {
    const results = await results1001();
    const idOf = (queryId: string) => Object.values(results).find((r) => r.query_id === queryId)!.run_query_id;
    const written = await recordRun({ run_id: "review-1001", as_of: "2026-10-01", results });
    expect(written.entities).toBeGreaterThan(0);
    expect(written.relations).toBeGreaterThan(0);
    expect(written.run_query_ids).toEqual(expect.arrayContaining([idOf("week_moves"), idOf("announcements_between"), idOf("fundamentals_latest")]));

    const [bx] = about(["BXPHARMA"]);
    expect(bx.symbol).toBe("BXPHARMA");
    expect(bx.announcements).toContainEqual(expect.objectContaining({ announcement_id: "a-066", url: `run_query:${idOf("announcements_between")}` }));
    expect(bx.facts).toContainEqual(expect.objectContaining({ predicate: "latest_eps", value: 1.62, url: `run_query:${idOf("fundamentals_latest")}`, as_of: "2026-10-01" }));
    expect(bx.facts).toContainEqual(expect.objectContaining({ predicate: "weight_pct", url: `run_query:${idOf("week_moves")}` }));
  });

  it("with the run's findings, records only the announcements a finding cites", async () => {
    const results = await results1001();
    const announcements = Object.values(results).find((r) => r.query_id === "announcements_between")!;
    const written = await recordRun({ run_id: "review-1001", as_of: "2026-10-01", results, findings: [{ kind: "announcement", subject: "BXPHARMA", cites: [announcements.run_query_id] }] });
    expect(written.relations).toBe(1);
    expect(about(["BXPHARMA"])[0].announcements.map((a) => a.announcement_id)).toEqual(["a-066"]);
    expect(about(["SQURPHARMA"])[0].announcements).toEqual([]);
  });

  it("keeps the World Model in <data dir>/memory/world, and a write with no provenance throws", async () => {
    const wm = openWorld();
    await expect(wm.upsertEntity({ type: "holding", externalKey: { system: "dse", id: "GP" }, source: undefined as never })).rejects.toThrow(/No provenance, no write/);
    expect(about(["NOTHELD"])).toEqual([]);
  });
});
