// Runs every named query that has sql() through Zetaris and compares the SQL's columns with local(). Run it with
// `npm run parity`. It always writes docs/zetaris-queries.md. It fails when Zetaris is not configured, when any
// call fell back to local data, or when a value differs, so it can never pass by comparing local with local.
// Loaded by tsx as CommonJS: an async main(), no top-level await. It prints no key and no URL.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/agent/config";
import { differences } from "../src/agent/parity-compare";
import {
  loadQueryData,
  prepareQuery,
  QUERIES,
  QUERY_IDS,
  QueryError,
  runQuery,
  type QueryData,
  type QueryId,
} from "../src/agent/queries";
import { startRun } from "../src/agent/trace";

const AS_OF = "2026-10-01";

// Fixed inputs: a week to 2026-10-01; the between-queries span the week before; BXPHARMA has the planted fall.
const CASES: Partial<Record<QueryId, Record<string, unknown>>> = {
  week_moves: { as_of: AS_OF },
  sector_vs_stock: { as_of: AS_OF },
  announcements_between: { from: "2026-09-24", to: AS_OF },
  fundamentals_latest: { symbol: "BXPHARMA", as_of: AS_OF },
  journal_for_symbol: { as_of: AS_OF },
};

const ZETARIS_VARIABLES = ["ZETARIS_REST_URL", "ZETARIS_ORG_ID", "ZETARIS_API_KEY"] as const;
const DOC = path.join(process.cwd(), "docs", "zetaris-queries.md");

const isLocalhost = (url: string): boolean => {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

type Section = { id: QueryId; params: Record<string, unknown>; sql: string; columns: readonly string[]; verdict: string };

function writeDoc(sections: Section[]): void {
  const lines = [
    "# Zetaris queries",
    "",
    `Written by \`npm run parity\` on ${new Date().toISOString().slice(0, 10)}. Each statement is what \`sql()\` in \`src/agent/queries.ts\` returns for the params shown, over the datasources \`tradeflow_ledger\` and \`tradeflow_external\`.`,
    "Parity compares only the columns each statement selects; `local()` adds the rest (the PORTFOLIO row, the labels, weights and text bodies).",
    "",
  ];
  for (const s of sections) {
    lines.push(
      `## ${s.id}`,
      "",
      `Params: \`${JSON.stringify(s.params)}\``,
      "",
      `Columns: ${s.columns.map((c) => `\`${c}\``).join(", ")}`,
      "",
      "```sql",
      s.sql,
      "```",
      "",
      s.verdict,
      "",
    );
  }
  writeFileSync(DOC, lines.join("\n"));
}

async function main(): Promise<number> {
  const config = loadConfig(process.env, () => {});
  const data: QueryData = await loadQueryData();
  const tracer = startRun("parity");
  const ids = QUERY_IDS.filter((id) => QUERIES[id].sql !== undefined);

  const missing = ZETARIS_VARIABLES.filter((name) => !process.env[name]?.trim());
  const configured = config.zetaris !== null;
  console.log(`ZETARIS_REST_URL points at localhost: ${config.zetaris !== null && isLocalhost(config.zetaris.restUrl) ? "yes" : "no"}`);

  const sections: Section[] = [];
  let failures = 0;
  for (const id of ids) {
    const q = QUERIES[id];
    const raw = CASES[id];
    if (raw === undefined) {
      console.log(`${id}: no parity case in scripts/parity.ts`);
      failures += 1;
      continue;
    }
    let prepared: ReturnType<typeof prepareQuery>;
    try {
      prepared = prepareQuery(id, raw, data);
    } catch (error) {
      console.log(`${id}: ${error instanceof QueryError ? error.message : "bad params"}`);
      failures += 1;
      continue;
    }
    const section: Section = { id, params: prepared.params, sql: q.sql!(prepared.params, data), columns: q.sqlColumns!, verdict: "parity: not run" };
    sections.push(section);
    if (!configured) continue;

    const remote = await runQuery({ query_id: id, params: raw, runId: "parity", tracer, config, sampleMode: false, data });
    if (remote.source !== "zetaris") {
      section.verdict = `parity: not run, the call fell back to local data (${remote.source})`;
      console.log(`${id}: FELL BACK (${remote.source}); parity did not compare`);
      failures += 1;
      continue;
    }
    const local = q.local(prepared.params, data);
    const diff = differences(q, local, remote.rows);
    if (diff.length === 0) {
      section.verdict = "parity: match";
      console.log(`${id}: match, ${remote.rows.length} rows`);
    } else {
      section.verdict = ["parity: DIFFERENCE", "", ...diff.slice(0, 20).map((d) => `- ${d}`), ...(diff.length > 20 ? [`- and ${diff.length - 20} more`] : [])].join("\n");
      console.log(`${id}: ${diff.length} difference(s)`);
      for (const d of diff.slice(0, 10)) console.log(`  ${d}`);
      failures += 1;
    }
  }

  writeDoc(sections);
  console.log(`wrote ${path.relative(process.cwd(), DOC)} with ${sections.length} sections`);
  if (!configured) {
    console.log(`Zetaris not configured: empty ${missing.join(", ")}`);
    return 1;
  }
  console.log(failures === 0 ? "parity: all queries match" : `parity: ${failures} query(ies) failed`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "parity failed");
    process.exit(1);
  },
);
