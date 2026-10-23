// Smoke test for the MCP server: npm run mcp-smoke (needs the app running; TRADEFLOW_URL, default http://localhost:8000).
// Starts scripts/mcp-server.ts through the SDK client, lists the tools, checks there is one per operation in
// /api/openapi.json plus run_review, calls get_api_portfolio for 2026-10-01 and compares it with
// GET /api/portfolio?as_of=2026-10-01. Prints "match" or the first difference; exit 1 on any difference.
// Runs under tsx as CommonJS: async main(), no top-level await.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = Record<string, unknown>;

const baseUrl = (process.env.TRADEFLOW_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const AS_OF = "2026-10-01";

const expectedName = (method: string, path: string) => `${method}_${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+/, "")}`;

/** The path of the first value that differs, or null when the two are equal. */
function firstDifference(a: unknown, b: unknown, at = "$"): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const found = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const found = firstDifference((a as Json)[key], (b as Json)[key], `${at}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

async function main(): Promise<number> {
  const fail = (message: string) => {
    console.log(`FAIL: ${message}`);
    return 1;
  };

  const openapi = (await (await fetch(`${baseUrl}/api/openapi.json`, { signal: AbortSignal.timeout(30_000) })).json()) as { paths: Record<string, Json> };
  const expected = new Set<string>(["run_review"]);
  for (const [path, item] of Object.entries(openapi.paths)) for (const method of ["get", "post"]) if (item[method]) expected.add(expectedName(method, path));

  const client = new Client({ name: "tradeflow-mcp-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "scripts/mcp-server.ts"], env: { ...getDefaultEnvironment(), TRADEFLOW_URL: baseUrl } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const missing = [...expected].filter((name) => !names.includes(name));
    const extra = names.filter((name) => !expected.has(name));
    if (missing.length > 0 || extra.length > 0 || names.length !== expected.size) {
      return fail(`tools: ${names.length} listed, ${expected.size} expected; missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`);
    }
    console.log(`tools: ${names.length} (${expected.size - 1} operations in /api/openapi.json plus run_review)`);

    const reply = await client.callTool({ name: "get_api_portfolio", arguments: { as_of: AS_OF } });
    const content = reply.content as { type: string; text: string }[];
    if (reply.isError) return fail(`get_api_portfolio returned an error: ${content[0]?.text}`);
    const viaMcp = JSON.parse(content[0].text) as unknown;
    const direct = (await (await fetch(`${baseUrl}/api/portfolio?as_of=${AS_OF}`, { signal: AbortSignal.timeout(30_000) })).json()) as unknown;
    const difference = firstDifference(viaMcp, direct);
    if (difference) return fail(`get_api_portfolio as_of ${AS_OF} differs from GET /api/portfolio at ${difference}`);
    console.log(`match: get_api_portfolio as_of ${AS_OF} equals GET /api/portfolio?as_of=${AS_OF}`);

    // The owner approves a ledger fix, never a tool: run_review refuses reconcile_approve before it calls the app.
    const refused = await client.callTool({ name: "run_review", arguments: { task: "reconcile_approve", input: {} } });
    if (!refused.isError) return fail("run_review accepted task reconcile_approve");
    console.log("refused: run_review rejects task reconcile_approve");
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
