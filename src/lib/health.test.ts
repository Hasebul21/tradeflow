import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health } from "./health";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tradeflow-"));
  process.env.TRADEFLOW_DATA_DIR = dir;
});
afterEach(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("health", () => {
  it("counts rows and marks missing files as null", async () => {
    await writeFile(path.join(dir, "bars.json"), "[1,2,3]\n");
    await writeFile(path.join(dir, "profile.json"), "{}\n");
    const h = await health();
    expect(h.status).toBe("ok");
    expect(h.data_dir_readable).toBe(true);
    expect(h.files.bars).toBe(3);
    expect(h.files.profile).toBe(1);
    expect(h.files.transactions).toBeNull();
    expect(h.files["sources/broker_statement"]).toBeNull();
  });
});
