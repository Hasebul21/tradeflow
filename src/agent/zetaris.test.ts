import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "./config";
import { QUERIES, QueryBlockedError, QueryError, loadQueryData, mergeRows, runLocal, runQuery, type QueryData, type QueryId, type Row } from "./queries";
import type { TraceInput, Tracer } from "./trace";
import { createZetarisClient, rowsFromArrays, toBoolean, toNumber, ZetarisError, ZetarisTimeout } from "./zetaris";

// Fake fetch and a fake client only: no test here touches the network. The data is the seed in data/.
let d: QueryData;
beforeAll(async () => {
  delete process.env.TRADEFLOW_DATA_DIR;
  d = await loadQueryData();
});

const ENV = { ZETARIS_REST_URL: "http://zetaris.test/api/v1.0/", ZETARIS_ORG_ID: "7", ZETARIS_API_KEY: "made-up-key-for-tests" };
const config: Config = loadConfig({ ...ENV, SAMPLE_MODE: "true" }, () => {});

// `lines` holds every line except the Guard's, which runQuery now writes first; `guard` holds those.
function collector() {
  const lines: TraceInput[] = [];
  const guard: TraceInput[] = [];
  const tracer = { log: (line: TraceInput) => ((line.agent_name === "Guard" ? guard : lines).push(line), line as never) } as unknown as Tracer;
  return { lines, guard, tracer };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const fetchOf = (...replies: Array<() => Response | Promise<Response>>) => {
  const fn = vi.fn<typeof fetch>();
  for (const reply of replies) fn.mockImplementationOnce(async () => reply());
  fn.mockImplementation(async () => replies[replies.length - 1]());
  return fn;
};
const clientOf = (fetchImpl: typeof fetch) => createZetarisClient(config.zetaris, fetchImpl)!;

const AS_OF = "2026-10-01";
const weekMoves = (extra: Partial<Parameters<typeof runQuery>[0]> = {}) => {
  const c = collector();
  return { ...c, call: (zetaris: ReturnType<typeof clientOf>) => runQuery({ query_id: "week_moves", params: { as_of: AS_OF }, runId: "t", tracer: c.tracer, config, sampleMode: false, data: d, zetaris, ...extra }) };
};
const localMoves = () => runLocal("week_moves", { as_of: AS_OF }, d).rows;

/** The reply Zetaris would give for week_moves: every holding's four columns as strings. */
function weekMovesReply() {
  const data = localMoves()
    .filter((r) => r.symbol !== "PORTFOLIO")
    .map((r) => [r.symbol, Number(r.from_close).toFixed(18), Number(r.to_close).toFixed(18), String(r.change_pct)]);
  return { headers: ["SYMBOL", "FROM_CLOSE", "TO_CLOSE", "CHANGE_PCT"], data };
}

describe("a Zetaris timeout", () => {
  it("is retried once, then local() rows come back as local-fallback with a fallback trace line", async () => {
    const fetchImpl = fetchOf(() => Promise.reject(timeoutError()));
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("local-fallback");
    expect(result.rows).toEqual(localMoves());
    const queryLines = lines.filter((l) => l.action === "query");
    expect(queryLines).toHaveLength(1);
    expect(queryLines[0]).toMatchObject({ agent_name: "Query", status: "fallback", source: "local-fallback" });
    expect(queryLines[0].why).toMatch(/timeout/);
    expect(lines.filter((l) => l.action === "retry")).toHaveLength(1);
  });

  it("recovers when the retry answers", async () => {
    const fetchImpl = fetchOf(() => Promise.reject(timeoutError()), () => json(weekMovesReply()));
    const { call } = weekMoves();
    const result = await call(clientOf(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("zetaris");
  });

  it("throws ZetarisTimeout from the client after the retry", async () => {
    const client = clientOf(fetchOf(() => Promise.reject(timeoutError())));
    await expect(client.run("SELECT 1", { timeoutMs: 5 })).rejects.toBeInstanceOf(ZetarisTimeout);
  });
});

describe("a Zetaris error", () => {
  it("401 is not retried: local() rows at once, local-fallback", async () => {
    const fetchImpl = fetchOf(() => json({ message: "bad key" }, 401));
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("local-fallback");
    expect(result.rows).toEqual(localMoves());
    expect(lines.at(-1)).toMatchObject({ status: "fallback", source: "local-fallback" });
    expect(lines.at(-1)!.why).toMatch(/unauthorized/);
    expect(lines.some((l) => l.action === "retry")).toBe(false);
  });

  it("bad SQL (400) and Postgres down behind Zetaris (500) fall back at once", async () => {
    for (const status of [400, 500]) {
      const fetchImpl = fetchOf(() => json({ message: "Table not found" }, status));
      const { call } = weekMoves();
      const result = await call(clientOf(fetchImpl));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.source).toBe("local-fallback");
      expect(result.rows).toEqual(localMoves());
    }
  });

  it("an unreachable Zetaris falls back, and the trace line names the cause, not the URL", async () => {
    const refused = () => Promise.reject(Object.assign(new TypeError("fetch failed for http://zetaris.test"), { cause: { code: "ECONNREFUSED" } }));
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchOf(refused)));
    expect(result.source).toBe("local-fallback");
    expect(lines.at(-1)!.why).toContain("ECONNREFUSED");
    expect(JSON.stringify(lines)).not.toContain("zetaris.test");
  });

  it("an HTTP error body that names a URL is masked in the trace", async () => {
    const body = { msg: "Connection to jdbc:postgresql://db.internal.example:5432/tradeflow_ledger refused, see https://db.internal.example/log" };
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchOf(() => json(body, 500))));
    expect(result.source).toBe("local-fallback");
    expect(lines.at(-1)!.why).toContain("[url]");
    expect(JSON.stringify(lines)).not.toContain("db.internal.example");
  });

  it("text in a numeric column falls back instead of becoming a null", async () => {
    const reply = weekMovesReply();
    reply.data[0][3] = "not a number";
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchOf(() => json(reply))));
    expect(result.source).toBe("local-fallback");
    expect(lines.at(-1)!.why).toMatch(/bad_reply/);
  });

  it("a SQL NULL in a numeric column stays null", () => {
    expect(rowsFromArrays(["a"], [[null], [""]], new Set(["a"]))).toEqual([{ a: null }, { a: null }]);
  });

  it("a reply that is not rows falls back", async () => {
    const { call } = weekMoves();
    expect((await call(clientOf(fetchOf(() => json({ data: "nope" }))))).source).toBe("local-fallback");
    expect((await call(clientOf(fetchOf(() => json({ data: [["too", "few"]] }))))).source).toBe("local-fallback");
  });
});

describe("the reply", () => {
  it('names positional rows from the SELECT list and converts numbers: "data": [["BXPHARMA", "-14.9"]]', async () => {
    const client = clientOf(fetchOf(() => json({ headers: ["SYMBOL", "CHANGE_PCT"], data: [["BXPHARMA", "-14.9"]] })));
    const reply = await client.run("SELECT symbol, change_pct FROM t", { timeoutMs: 1000 });
    expect(rowsFromArrays(["symbol", "change_pct"], reply.data, new Set(["change_pct"]))).toEqual([{ symbol: "BXPHARMA", change_pct: -14.9 }]);
  });

  it("reads 0E-18 as 0 and long decimals as numbers, and empty cells as null", () => {
    expect(toNumber("0E-18")).toBe(0);
    expect(toNumber("513.700000000000000000")).toBe(513.7);
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber("n/a")).toBeNull();
  });

  it("reads true and false text as booleans", () => {
    expect(toBoolean("true")).toBe(true);
    expect(toBoolean("false")).toBe(false);
    expect(toBoolean("t")).toBeNull();
    expect(rowsFromArrays(["id", "flag"], [["a-1", "true"]], new Set(), new Set(["flag"]))).toEqual([{ id: "a-1", flag: true }]);
  });

  it("treats a missing or null data field as no rows, not an error", async () => {
    for (const body of [{ headers: [] }, { data: null }, { data: [] }]) {
      const reply = await clientOf(fetchOf(() => json(body))).run("SELECT 1", { timeoutMs: 1000 });
      expect(reply.data).toEqual([]);
    }
  });

  it("rejects a row with the wrong number of cells", () => {
    expect(() => rowsFromArrays(["a", "b"], [["only one"]])).toThrow(ZetarisError);
  });
});

describe("a Zetaris call", () => {
  it("sends the headers, a new uuid each time and one statement with no trailing semicolon", async () => {
    const fetchImpl = fetchOf(() => json(weekMovesReply()));
    const { call } = weekMoves();
    await call(clientOf(fetchImpl));
    await call(clientOf(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    const body = JSON.parse(init!.body as string);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(url).toBe("http://zetaris.test/api/v1.0/sql-editor/sqls/run");
    expect(init!.method).toBe("POST");
    expect(headers.Authorization).toBe(`Bearer ${ENV.ZETARIS_API_KEY}`);
    expect(headers["X-Org-ID"]).toBe("7");
    expect(headers["X-Request-ID"]).toMatch(uuid);
    expect(body).toMatchObject({ source: "SqlEditor", limit: 1000 });
    expect(body.queryId).toMatch(uuid);
    expect(body.sql).toMatch(/^SELECT symbol, from_close/);
    expect(body.sql.trim().endsWith(";")).toBe(false);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect((fetchImpl.mock.calls[1][1]!.headers as Record<string, string>)["X-Request-ID"]).not.toBe(headers["X-Request-ID"]);
  });

  it("writes one Query trace line with the query id, source zetaris, the start of the SQL and a row count", async () => {
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchOf(() => json(weekMovesReply()))));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({ agent_name: "Query", action: "query", status: "ok", source: "zetaris" });
    expect(line.input_summary).toContain("week_moves");
    expect(line.input_summary).toContain("source=zetaris");
    expect(line.input_summary).toContain('"as_of":"2026-10-01"');
    expect(line.input_summary).toContain("sql: SELECT symbol, from_close, to_close");
    expect(line.output_summary).toBe(`${result.rows.length} rows`);
    expect(line.duration_ms).toBeTypeOf("number");
    // The SQL in the line is cut at 120 characters.
    expect(line.input_summary.split("sql: ")[1].length).toBeLessThanOrEqual(120);
    expect(result.sql_head).toBe(line.input_summary.split("sql: ")[1]);
  });

  it("keeps the PORTFOLIO row first and the local labels, and takes the SQL's numbers", async () => {
    const { call } = weekMoves();
    const reply = weekMovesReply();
    const bx = reply.data.find((r) => r[0] === "BXPHARMA")!;
    bx[3] = "-14.88";
    const { rows } = await call(clientOf(fetchOf(() => json(reply))));
    expect(rows[0].symbol).toBe("PORTFOLIO");
    const row = rows.find((r) => r.symbol === "BXPHARMA")!;
    const was = localMoves().find((r) => r.symbol === "BXPHARMA")!;
    // Long decimal strings become numbers equal to the local figures.
    expect(row.from_close).toBe(was.from_close);
    expect(row.to_close).toBe(was.to_close);
    expect(row.change_pct).toBe(-14.88);
    expect(row.comparison).toBe("stock-specific");
    expect(rows.map((r) => r.symbol)).toEqual(localMoves().map((r) => r.symbol));
  });

  it("returns rows: [] when Zetaris returns no rows", async () => {
    const { lines, call } = weekMoves();
    const result = await call(clientOf(fetchOf(() => json({ headers: [], data: [] }))));
    expect(result.rows).toEqual([]);
    expect(result.source).toBe("zetaris");
    expect(lines[0].output_summary).toBe("0 rows");
    expect(lines[0].status).toBe("ok");
  });
});

describe("runQuery", () => {
  it("in sample mode runs local(): the local rows, source local, one Query trace line", async () => {
    const { lines, tracer } = collector();
    const fetchImpl = fetchOf(() => json(weekMovesReply()));
    const result = await runQuery({
      query_id: "week_moves",
      params: { as_of: "2026-10-01" },
      runId: "t",
      tracer,
      config,
      sampleMode: true,
      zetaris: clientOf(fetchImpl),
    });
    expect(result.source).toBe("local");
    expect(result.rows).toEqual(localMoves());
    expect(result.sql_head).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agent_name: "Query", action: "query", status: "ok", source: "local" });
    expect(lines[0].why).toMatch(/sample mode/);
  });

  it("runs locally, and says so, when Zetaris is not configured", async () => {
    const { lines, tracer } = collector();
    const none = loadConfig({ SAMPLE_MODE: "true" }, () => {});
    const result = await runQuery({ query_id: "week_moves", params: { as_of: AS_OF }, runId: "t", tracer, config: none, sampleMode: false, data: d });
    expect(result.source).toBe("local");
    expect(lines[0].why).toBe("Zetaris not configured");
  });

  it("never sends what_if to Zetaris, and the trace says why", async () => {
    const fetchImpl = fetchOf(() => json({ data: [] }));
    const { lines, tracer } = collector();
    const result = await runQuery({
      query_id: "what_if",
      params: { symbol: "GP", side: "buy", quantity: 10, as_of: AS_OF },
      runId: "t",
      tracer,
      config,
      sampleMode: false,
      data: d,
      zetaris: clientOf(fetchImpl),
    });
    expect(result.source).toBe("local");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines[0].why).toMatch(/what_if has no sql\(\).*always runs locally/);
    expect(QUERIES.what_if.sql).toBeUndefined();
  });

  it("runs the queries that have no sql() yet locally with source local", async () => {
    for (const [id, params] of [
      ["dividends_between", { from: "2026-09-01", to: AS_OF }],
      ["rule_findings", { as_of: AS_OF }],
      ["reconciliation", {}],
    ] as const) {
      const fetchImpl = fetchOf(() => json({ data: [] }));
      const { lines, tracer } = collector();
      const result = await runQuery({ query_id: id, params, runId: "t", tracer, config, sampleMode: false, data: d, zetaris: clientOf(fetchImpl) });
      expect(result.source).toBe("local");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(lines[0].input_summary).toContain("source=local");
    }
  });

  it("answers an unknown symbol the same in sample mode and with Zetaris: no SQL is sent", async () => {
    const params = { from: "2026-09-24", to: AS_OF, symbol: "NOSUCH" };
    const live = collector();
    const fetchImpl = fetchOf(() => json({ data: [] }));
    const a = await runQuery({ query_id: "announcements_between", params, runId: "t", tracer: live.tracer, config, sampleMode: false, data: d, zetaris: clientOf(fetchImpl) });
    const sample = collector();
    const b = await runQuery({ query_id: "announcements_between", params, runId: "t", tracer: sample.tracer, config, sampleMode: true, data: d });
    expect(a.rows).toEqual(b.rows);
    expect(a.source).toBe("local");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(live.lines).toHaveLength(1);
    expect(live.lines[0].why).toMatch(/no SQL sent: Unknown symbol NOSUCH/);
  });

  it("traces a refusal from local() before rethrowing it", async () => {
    const fetchImpl = fetchOf(() => json({ data: [] }));
    for (const sampleMode of [true, false]) {
      const { lines, tracer } = collector();
      await expect(
        runQuery({ query_id: "fundamentals_latest", params: { symbol: "NOSUCH", as_of: AS_OF }, runId: "t", tracer, config, sampleMode, data: d, zetaris: clientOf(fetchImpl) }),
      ).rejects.toBeInstanceOf(QueryError);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ agent_name: "Query", status: "error" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps long params in the trace line", async () => {
    const { lines, tracer } = collector();
    await runQuery({ query_id: "announcements_between", params: { from: "2026-09-24", to: AS_OF, symbol: "GP" }, runId: "t", tracer, config, sampleMode: true, data: d });
    expect(lines[0].input_summary.length).toBeLessThan(260);
    const bad = collector();
    await expect(runQuery({ query_id: "week_moves", params: { as_of: "x".repeat(500) }, runId: "t", tracer: bad.tracer, config, sampleMode: true, data: d })).rejects.toBeInstanceOf(QueryBlockedError);
    expect(bad.guard[0].input_summary.length).toBeLessThan(260);
  });

  it("throws a QueryBlockedError for bad params: a Guard block line and no Query line", async () => {
    const { lines, guard, tracer } = collector();
    await expect(runQuery({ query_id: "week_moves", params: { as_of: "yesterday" }, runId: "t", tracer, config, sampleMode: true, data: d })).rejects.toBeInstanceOf(QueryBlockedError);
    expect(lines).toHaveLength(0);
    expect(guard).toHaveLength(1);
    expect(guard[0]).toMatchObject({ agent_name: "Guard", action: "block", status: "blocked" });
  });

  it("throws a QueryBlockedError for an unknown query_id: a Guard block line that names it and no Query line", async () => {
    const { lines, guard, tracer } = collector();
    const error = await runQuery({ query_id: "no_such_query", params: {}, runId: "t", tracer, config, sampleMode: true, data: d }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryBlockedError);
    expect((error as QueryBlockedError).reason).toMatch(/no_such_query/);
    expect(guard).toHaveLength(1);
    expect(guard[0]).toMatchObject({ agent_name: "Guard", action: "block", status: "blocked" });
    expect(lines.filter((l) => l.agent_name === "Query")).toHaveLength(0);
  });
});

describe("sql()", () => {
  const PARAMS: Partial<Record<QueryId, Record<string, unknown>>> = {
    week_moves: { as_of: AS_OF, sessions: 5 },
    sector_vs_stock: { as_of: AS_OF, sessions: 5 },
    announcements_between: { from: "2026-09-24", to: AS_OF, symbol: "BXPHARMA" },
    fundamentals_latest: { symbol: "BXPHARMA", as_of: AS_OF },
    journal_for_symbol: { as_of: AS_OF, symbol: "GP" },
  };
  const withSql = (Object.keys(QUERIES) as QueryId[]).filter((id) => QUERIES[id].sql);
  const tables = new Set(readFileSync(path.join(process.cwd(), "docs", "zetaris-tables.txt"), "utf8").split("\n").filter(Boolean));

  it("exists for the five first queries, and not for the rest", () => {
    expect(withSql.sort()).toEqual(["announcements_between", "fundamentals_latest", "journal_for_symbol", "sector_vs_stock", "week_moves"]);
  });

  it("is one statement with no trailing semicolon, and only qualified tables that SHOW DATASOURCE TABLES listed", () => {
    expect(tables.size).toBeGreaterThan(0);
    for (const id of withSql) {
      const sql = QUERIES[id].sql!(PARAMS[id], d);
      expect(sql.trim().endsWith(";"), id).toBe(false);
      expect(sql.includes(";"), id).toBe(false);
      const used = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(tradeflow_\w+\.\w+)/g)].map((m) => m[1]);
      expect(used.length, id).toBeGreaterThan(0);
      for (const name of used) expect(tables.has(name), `${id}: ${name}`).toBe(true);
    }
  });

  it("selects exactly the columns it declares, in order", () => {
    for (const id of withSql) {
      const q = QUERIES[id];
      const sql = q.sql!(PARAMS[id], d);
      let last = -1;
      for (const column of q.sqlColumns!) {
        const at = sql.search(new RegExp(`(?:\\bAS\\s+${column}\\b|[\\s.,]${column}\\s*(?:,|\\n|FROM|\\bAS\\b))`));
        expect(at, `${id}.${column}`).toBeGreaterThan(-1);
        expect(at, `${id}.${column} is out of order`).toBeGreaterThan(last);
        last = at;
      }
    }
  });

  it("refuses a symbol outside instruments before it reaches SQL", () => {
    expect(() => QUERIES.fundamentals_latest.sql!({ symbol: "NOSUCH", as_of: AS_OF }, d)).toThrow(QueryError);
    expect(() => QUERIES.fundamentals_latest.sql!({ symbol: "GP'; DROP TABLE bars --", as_of: AS_OF }, d)).toThrow(QueryError);
    expect(() => QUERIES.announcements_between.sql!({ from: "2026-09-24", to: AS_OF, symbol: "x' OR '1'='1" }, d)).toThrow(QueryError);
    expect(() => QUERIES.journal_for_symbol.sql!({ as_of: AS_OF, symbol: "NOSUCH" }, d)).toThrow(QueryError);
  });

  it("puts only a validated date in the statement", () => {
    expect(() => QUERIES.week_moves.sql!({ as_of: "2026-10-01'; --", sessions: 5 }, d)).toThrow(QueryError);
    expect(() => QUERIES.week_moves.sql!({ as_of: AS_OF, sessions: 5.5 }, d)).toThrow(QueryError);
  });

  it("changes with as_of and with sessions", () => {
    const sql = (p: Record<string, unknown>) => QUERIES.week_moves.sql!(p, d);
    expect(sql({ as_of: AS_OF, sessions: 5 })).not.toBe(sql({ as_of: "2026-09-24", sessions: 5 }));
    expect(sql({ as_of: AS_OF, sessions: 5 })).not.toBe(sql({ as_of: AS_OF, sessions: 10 }));
  });
});

describe("QueryBlockedError", () => {
  it("carries the reason a guard gave", () => {
    const error = new QueryBlockedError("too many query calls");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("too many query calls");
    expect(error.name).toBe("QueryBlockedError");
  });
});

describe("mergeRows", () => {
  const q = QUERIES.week_moves;
  const local: Row[] = [
    { symbol: "PORTFOLIO", change_pct: -1.67 },
    { symbol: "A", change_pct: 1, label: "x" },
    { symbol: "B", change_pct: 2, label: "y" },
  ];

  it("keeps local's order and extra columns, and the SQL's values", () => {
    const sql: Row[] = [{ symbol: "B", change_pct: 2.5 }, { symbol: "A", change_pct: 1.5 }];
    expect(mergeRows(q, local, sql)).toEqual([
      { symbol: "PORTFOLIO", change_pct: -1.67 },
      { symbol: "A", change_pct: 1.5, label: "x" },
      { symbol: "B", change_pct: 2.5, label: "y" },
    ]);
  });

  it("lets Zetaris decide which rows exist", () => {
    expect(mergeRows(q, local, [{ symbol: "A", change_pct: 1 }, { symbol: "C", change_pct: 3 }]).map((r) => r.symbol)).toEqual(["PORTFOLIO", "A", "C"]);
  });

  it("returns no rows when the SQL returned none", () => {
    expect(mergeRows(q, local, [])).toEqual([]);
  });
});
