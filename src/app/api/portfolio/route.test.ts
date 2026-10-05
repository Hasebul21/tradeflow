import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture } from "@/test/fixture";
import { GET } from "./route";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-"));
  process.env.TRADEFLOW_DATA_DIR = dir;
  const f = fixture();
  await writeFile(path.join(dir, "bars.json"), JSON.stringify(f.bars));
  await writeFile(path.join(dir, "transactions.json"), JSON.stringify(f.transactions));
  await writeFile(path.join(dir, "instruments.json"), JSON.stringify([...f.instruments.values()]));
  await writeFile(path.join(dir, "index_bars.json"), JSON.stringify(f.indexBars));
});
afterAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const get = (query: string) => GET(new NextRequest(`http://localhost/api/portfolio${query}`));

describe("GET /api/portfolio", () => {
  it("defaults to the latest session, and builds a past one", async () => {
    expect((await (await get("")).json()).asOf).toBe("2026-10-05");
    const past = await (await get("?as_of=2026-09-28")).json();
    expect(past.asOf).toBe("2026-09-28");
    expect(past.holdings).toHaveLength(1);
  });

  it("resolves a Saturday to the Thursday before", async () => {
    expect((await (await get("?as_of=2026-10-03")).json()).asOf).toBe("2026-10-01");
  });

  it("returns a clear 400 for a date before or after the data", async () => {
    const before = await get("?as_of=2025-01-01");
    expect(before.status).toBe(400);
    expect((await before.json()).error).toMatch(/before the data, which starts on 2026-09-20/);
    const after = await get("?as_of=2027-01-01");
    expect(after.status).toBe(400);
    expect((await after.json()).error).toMatch(/after the data, which ends on 2026-10-05/);
  });
});
