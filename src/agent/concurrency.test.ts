import { describe, expect, it } from "vitest";
import { runWithLimit, withLock } from "./concurrency";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runWithLimit", () => {
  it("keeps the jobs' order, runs at most 2 at once and takes three slots for five 100 ms jobs", async () => {
    let running = 0;
    let peak = 0;
    const jobs = [0, 1, 2, 3, 4].map((n) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(100);
      running -= 1;
      return n;
    });
    const started = Date.now();
    const results = await runWithLimit(jobs, 2);
    const took = Date.now() - started;
    expect(results).toEqual([0, 1, 2, 3, 4].map((value) => ({ status: "fulfilled", value })));
    expect(peak).toBe(2);
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(450);
  });

  it("turns a rejection into a rejected result and keeps the other four", async () => {
    const boom = new Error("boom");
    const jobs = [0, 1, 2, 3, 4].map((n) => async () => {
      await sleep(20);
      if (n === 2) throw boom;
      return n;
    });
    const results = await runWithLimit(jobs, 2);
    expect(results[2]).toEqual({ status: "rejected", reason: boom });
    expect(results.filter((result) => result.status === "fulfilled").map((result) => (result as { value: number }).value)).toEqual([0, 1, 3, 4]);
  });

  it("never throws for a job that throws before it returns a promise, an empty list or a bad limit", async () => {
    const throwing = (() => {
      throw new Error("sync");
    }) as unknown as () => Promise<number>;
    expect((await runWithLimit([throwing], 2))[0].status).toBe("rejected");
    expect(await runWithLimit([], 3)).toEqual([]);
    expect(await runWithLimit([async () => 1, async () => 2], 0)).toEqual([{ status: "fulfilled", value: 1 }, { status: "fulfilled", value: 2 }]);
  });

  it("runs one job at a time at limit 1", async () => {
    let running = 0;
    let peak = 0;
    const jobs = [1, 2, 3].map(() => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(10);
      running -= 1;
    });
    await runWithLimit(jobs, 1);
    expect(peak).toBe(1);
  });
});

describe("withLock", () => {
  it("runs calls for one key one at a time in call order, and lets another key run beside them", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      withLock("a", async () => {
        log.push(`start ${name}`);
        await sleep(ms);
        log.push(`end ${name}`);
      });
    const other = withLock("b", async () => {
      log.push("b");
    });
    await Promise.all([job("1", 30), job("2", 5), job("3", 1), other]);
    expect(log.filter((entry) => entry !== "b")).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    expect(log.indexOf("b")).toBeLessThan(log.indexOf("end 1"));
  });

  it("starts the next call after a failure and passes the failure to its own caller", async () => {
    const failing = withLock("c", async () => {
      throw new Error("first");
    });
    const next = withLock("c", async () => "second");
    await expect(failing).rejects.toThrow("first");
    await expect(next).resolves.toBe("second");
  });
});
