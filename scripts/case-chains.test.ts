import { describe, expect, it } from "vitest";
import { CASE_CHAINS, CASE_DEPENDS, chainGroups, chainsFirst, parseConcurrency, parseOnly, runChains, selectCases } from "./case-chains";
import { listCases } from "./eval-cases";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ALL_IDS = listCases(process.cwd())
  .filter((item) => !item.skipped)
  .map((item) => item.id);

describe("chainGroups", () => {
  it("puts example_3a, example_3b, example_7a and example_7b in one group, in that order, and every other case alone", () => {
    const groups = chainGroups(ALL_IDS);
    expect(groups).toContainEqual(["example_3a", "example_3b", "example_7a", "example_7b"]);
    expect(groups.filter((group) => group.length > 1)).toHaveLength(1);
    expect(groups.flat().sort()).toEqual([...ALL_IDS].sort());
    expect(groups.findIndex((group) => group[0] === "example_3a")).toBe(groups.findIndex((group) => group[0] === "example_2") + 1);
  });

  it("keeps only the chain members that are present, and refuses a case listed in two chains", () => {
    expect(chainGroups(["x", "c", "a"], [["a", "b", "c"]])).toEqual([["x"], ["a", "c"]]);
    expect(() => chainGroups(["a"], [["a", "b"], ["c", "a"]])).toThrow("Case a is in two chains.");
  });

  it("lists only cases that exist", () => {
    for (const chain of CASE_CHAINS) for (const id of chain) expect(ALL_IDS).toContain(id);
  });
});

describe("--only: parseOnly and selectCases", () => {
  it("splits, trims and dedupes the list, and refuses a missing list or an empty id", () => {
    expect(parseOnly("example_2, example_7b,example_2")).toEqual({ ids: ["example_2", "example_7b"], error: null });
    expect(parseOnly(undefined).error).toMatch(/--only needs a list/);
    expect(parseOnly("--out").error).toMatch(/--only needs a list/);
    expect(parseOnly("example_2,,example_4").error).toMatch(/empty case id/);
  });

  it("runs example_3a and example_7a before example_7b, in chain order, and only example_3a before example_7a", () => {
    const selected = selectCases(ALL_IDS, ["example_7b"]);
    expect(selected).toEqual({ ids: ["example_3a", "example_7a", "example_7b"], error: null });
    expect(chainGroups(selected.ids)).toEqual([["example_3a", "example_7a", "example_7b"]]);
    expect(selectCases(ALL_IDS, ["example_7a"]).ids).toEqual(["example_3a", "example_7a"]);
    expect(selectCases(ALL_IDS, ["example_3b"]).ids).toEqual(["example_3a", "example_3b"]);
    expect(selectCases(ALL_IDS, ["example_3b", "example_7b"]).ids).toEqual(["example_3a", "example_3b", "example_7a", "example_7b"]);
  });

  it("declares each dependency earlier in the same chain, so the chain order satisfies it", () => {
    for (const [id, needs] of Object.entries(CASE_DEPENDS)) {
      const chain = CASE_CHAINS.find((members) => members.includes(id)) as readonly string[];
      expect(chain).toBeDefined();
      for (const needed of needs) {
        expect(chain.indexOf(needed)).toBeGreaterThanOrEqual(0);
        expect(chain.indexOf(needed)).toBeLessThan(chain.indexOf(id));
      }
    }
  });

  it("runs only the named cases with --no-chain-deps, and a case in no chain alone", () => {
    expect(selectCases(ALL_IDS, ["example_7b"], false)).toEqual({ ids: ["example_7b"], error: null });
    expect(selectCases(ALL_IDS, ["example_2"])).toEqual({ ids: ["example_2"], error: null });
  });

  it("keeps the usual case order whatever order the list gives, and adds nothing for a chain's first case", () => {
    expect(selectCases(ALL_IDS, ["example_4", "example_3a", "example_2"]).ids).toEqual(["example_2", "example_3a", "example_4"]);
  });

  it("refuses an unknown id and names it", () => {
    const selected = selectCases(ALL_IDS, ["example_2", "example_99"]);
    expect(selected.ids).toEqual([]);
    expect(selected.error).toMatch(/^Unknown case id for --only: example_99\./);
  });

  it("follows dependencies to the end and brings only the cases that exist", () => {
    expect(selectCases(["a", "b", "c", "x"], ["c"], true, { c: ["b"], b: ["a"] }).ids).toEqual(["a", "b", "c"]);
    expect(selectCases(["a", "c", "x"], ["c"], true, { c: ["b"], b: ["a"] }).ids).toEqual(["c"]);
  });
});

describe("chainsFirst", () => {
  it("moves every chain ahead of the lone cases and keeps each kind in its order", () => {
    expect(chainsFirst([["a"], ["b"], ["c", "d"], ["e"], ["f", "g"]])).toEqual([["c", "d"], ["f", "g"], ["a"], ["b"], ["e"]]);
    expect(chainsFirst(chainGroups(ALL_IDS))[0]).toEqual(["example_3a", "example_3b", "example_7a", "example_7b"]);
  });
});

describe("runChains at concurrency 3", () => {
  it("runs example_3b after example_3a and example_7b after example_7a, every time", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = new Map<string, number>();
      const ended = new Map<string, number>();
      let clock = 0;
      await runChains(
        chainsFirst(chainGroups(ALL_IDS)),
        async (group) => {
          for (const id of group) {
            started.set(id, (clock += 1));
            await sleep(Math.floor(Math.random() * 4));
            ended.set(id, (clock += 1));
          }
        },
        3,
      );
      expect(started.get("example_3b")).toBeGreaterThan(ended.get("example_3a") as number);
      expect(started.get("example_7a")).toBeGreaterThan(ended.get("example_3b") as number);
      expect(started.get("example_7b")).toBeGreaterThan(ended.get("example_7a") as number);
      expect(started.size).toBe(ALL_IDS.length);
    }
  });
});

describe("parseConcurrency", () => {
  it("defaults to 1, reads EVAL_CONCURRENCY, and lets --concurrency win", () => {
    expect(parseConcurrency(["--no-results"], undefined)).toEqual({ concurrency: 1, rest: ["--no-results"], error: null });
    expect(parseConcurrency([], "2").concurrency).toBe(2);
    expect(parseConcurrency(["--concurrency", "3"], "2")).toEqual({ concurrency: 3, rest: [], error: null });
    expect(parseConcurrency(["--concurrency=3", "--no-results"], undefined)).toEqual({ concurrency: 3, rest: ["--no-results"], error: null });
  });

  it("refuses 0, a fraction, a word and a missing value", () => {
    expect(parseConcurrency(["--concurrency", "0"], undefined).error).toContain("whole number of at least 1");
    expect(parseConcurrency(["--concurrency", "1.5"], undefined).error).toContain("whole number of at least 1");
    expect(parseConcurrency([], "three").error).toContain("EVAL_CONCURRENCY");
    expect(parseConcurrency(["--concurrency"], undefined).error).toBe("--concurrency needs a number.");
  });
});
