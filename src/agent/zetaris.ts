// The Zetaris REST client: one Lightning SQL statement in, positional rows out. Request format adapted from
// zetaris/getting-started (https://github.com/zetaris/getting-started, scripts/zetaris_sql.py class RestChannel),
// under the licence its LICENSE file names: Apache License 2.0. Settings come from Config (process.env) only.
// Server only: no client component or edge route imports it.
import { randomUUID } from "node:crypto";
import type { Config } from "./config";

/** What the reply's `data` holds: strings, usually, even for numbers. */
export type Cell = string | number | boolean | null;

export type ZetarisRow = Record<string, unknown>;

export type ZetarisErrorType = "timeout" | "unauthorized" | "http" | "network" | "bad_reply";

/** A Zetaris call that failed. `type` says why; the message never holds the URL, a key or a password. */
export class ZetarisError extends Error {
  constructor(
    readonly type: ZetarisErrorType,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZetarisError";
  }
}

/** The call ran out of time, twice. */
export class ZetarisTimeout extends ZetarisError {
  constructor(timeoutMs: number) {
    super("timeout", `Zetaris did not answer within ${timeoutMs} ms, after one retry.`);
    this.name = "ZetarisTimeout";
  }
}

export type ZetarisReply = {
  data: Cell[][];
  /** The reply's own column names. Their case varies, so callers name columns from their SELECT list instead. */
  headers: string[];
  durationMs: number;
  /** The statement that was sent, kept so a citation can show it. */
  sql: string;
};

export interface ZetarisClient {
  /** `onRetry` runs once, just before the one retry after a timeout, so the caller can trace it. */
  run(sql: string, opts: { timeoutMs: number; onRetry?: () => void }): Promise<ZetarisReply>;
}

/** Rows asked for in one call; the named queries aggregate in SQL, so this is a ceiling, not a target. */
const ROW_LIMIT = 1000;
const ERROR_BODY_CHARS = 300;

/** The REST client, or null when URL, org id and API key are not all set. `fetchImpl` is for tests. */
export function createZetarisClient(cfg: Config["zetaris"], fetchImpl: typeof fetch = fetch): ZetarisClient | null {
  if (cfg === null) return null;
  const base = cfg.restUrl.replace(/\/+$/, "");
  return {
    async run(sql, { timeoutMs, onRetry }) {
      const started = Date.now();
      // One retry, on a timeout only: a 401 or bad SQL gives the same answer twice.
      for (let attempt = 0; ; attempt++) {
        try {
          const reply = await post(base, cfg, sql, timeoutMs, fetchImpl);
          return { ...reply, sql, durationMs: Date.now() - started };
        } catch (error) {
          if (error instanceof ZetarisError && error.type === "timeout" && attempt === 0) {
            onRetry?.();
            continue;
          }
          if (error instanceof ZetarisError && error.type === "timeout") throw new ZetarisTimeout(timeoutMs);
          throw error;
        }
      }
    },
  };
}

async function post(
  base: string,
  cfg: NonNullable<Config["zetaris"]>,
  sql: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Omit<ZetarisReply, "durationMs" | "sql">> {
  let response: Response;
  try {
    response = await fetchImpl(`${base}/sql-editor/sqls/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "X-Org-ID": cfg.orgId,
        "X-Request-ID": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: ROW_LIMIT }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ZetarisError("timeout", "The request timed out.");
    }
    // The cause code (ECONNREFUSED, ENOTFOUND) names the problem; the message of a failed fetch can hold the URL.
    const code = error instanceof Error && typeof (error.cause as { code?: unknown } | undefined)?.code === "string" ? (error.cause as { code: string }).code : "unknown";
    throw new ZetarisError("network", `Cannot reach Zetaris (${code}).`);
  }

  if (!response.ok) {
    // An error body can name the host it could not reach; a URL never goes into a trace line.
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, ERROR_BODY_CHARS);
    const type: ZetarisErrorType = response.status === 401 ? "unauthorized" : "http";
    throw new ZetarisError(type, `HTTP ${response.status}${body ? `: ${body}` : ""}`, response.status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ZetarisError("bad_reply", "The reply was not JSON.", response.status);
  }
  return parseReply(json);
}

function parseReply(json: unknown): Omit<ZetarisReply, "durationMs" | "sql"> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new ZetarisError("bad_reply", "The reply was not a JSON object.");
  const { data, headers } = json as { data?: unknown; headers?: unknown };
  // No rows can arrive as a missing or null data field: that is an empty answer, not an error.
  const rows = data === undefined || data === null ? [] : data;
  if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) throw new ZetarisError("bad_reply", "The reply's data was not an array of row arrays.");
  return {
    data: rows as Cell[][],
    headers: Array.isArray(headers) ? headers.map(String) : [],
  };
}

/** A number from a cell: "12.50" is 12.5 and "0E-18" is 0. Empty, null and non-numeric cells are null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A boolean from a cell: "true" and "false" arrive as text. Anything else is null. */
export function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text === "true" ? true : text === "false" ? false : null;
}

/**
 * Names positional rows from the SELECT list. A column in `numeric` is converted with toNumber and one in
 * `booleans` with toBoolean; every other cell stays as it came. A row shorter or longer than the list, or a
 * numeric cell that holds non-numeric text, is a bad reply.
 */
export function rowsFromArrays(
  columns: readonly string[],
  data: readonly (readonly Cell[])[],
  numeric: ReadonlySet<string> = new Set(),
  booleans: ReadonlySet<string> = new Set(),
): ZetarisRow[] {
  return data.map((cells) => {
    if (cells.length !== columns.length) {
      throw new ZetarisError("bad_reply", `A row had ${cells.length} cells for ${columns.length} columns.`);
    }
    return Object.fromEntries(
      columns.map((name, i) => {
        const cell = cells[i];
        if (numeric.has(name)) {
          const n = toNumber(cell);
          // A null or empty cell is a SQL NULL. Text that is not a number is a bad reply: it must not turn into a null.
          if (n === null && typeof cell === "string" && cell.trim() !== "") throw new ZetarisError("bad_reply", `Column ${name} held text that is not a number.`);
          return [name, n];
        }
        return [name, booleans.has(name) ? toBoolean(cell) : cell];
      }),
    );
  });
}
