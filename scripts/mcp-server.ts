// MCP server over stdio: npm run mcp (or npx tsx scripts/mcp-server.ts, as .mcp.json does).
// At start it reads /api/openapi.json from TRADEFLOW_URL (default http://localhost:8000) and registers one tool per
// operation, named <method>_<path with every run of other characters as one _> (GET /api/portfolio is
// get_api_portfolio). Each call is a fetch to the running app with a 30 s timeout. One more tool, run_review, posts
// to /run. Stdout carries the protocol and nothing else: log to stderr only, and don't import src/agent/config.ts.
// Uses the SDK's low-level Server so every OpenAPI schema goes out unchanged. Runs under tsx as CommonJS.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

type Json = Record<string, unknown>;
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Json };
type Operation = { summary?: string; parameters?: Parameter[]; requestBody?: { content?: { "application/json"?: { schema?: Json } } } };
type OpenApi = { info?: { version?: string }; paths: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Json> } };
type Route = { method: "GET" | "POST"; path: string; query: string[]; required: string[]; hasBody: boolean };

const CALL_TIMEOUT_MS = 30_000;
const RUN_MARGIN_MS = 10_000;
const METHODS = ["get", "post"] as const;
/** The tasks run_review may start. reconcile_approve and feedback write, so only the owner starts them, in the Explain page. */
const REVIEW_TASKS = ["explain_week", "thesis_check", "pre_trade", "reconcile", "briefing"];

const baseUrl = (process.env.TRADEFLOW_URL ?? "http://localhost:8000").replace(/\/+$/, "");

const log = (message: string) => console.error(`[tradeflow-mcp] ${message}`);

function msFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function toolName(method: string, path: string): string {
  return `${method.toLowerCase()}_${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+/, "")}`;
}

/** Follows a "#/components/schemas/X" reference; any other schema comes back as it is. */
function resolve(doc: OpenApi, schema: Json | undefined): Json {
  const ref = schema?.$ref;
  if (typeof ref !== "string") return schema ?? {};
  return doc.components?.schemas?.[ref.replace("#/components/schemas/", "")] ?? {};
}

function buildTools(doc: OpenApi): { tools: Tool[]; routes: Map<string, Route> } {
  const tools: Tool[] = [];
  const routes = new Map<string, Route>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const parameters = operation.parameters ?? [];
      const body = resolve(doc, operation.requestBody?.content?.["application/json"]?.schema);
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const parameter of parameters) {
        properties[parameter.name] = { ...parameter.schema, ...(parameter.description ? { description: parameter.description } : {}) };
        if (parameter.required) required.push(parameter.name);
      }
      Object.assign(properties, body.properties as Record<string, Json> | undefined);
      required.push(...((body.required as string[] | undefined) ?? []));
      const name = toolName(method, path);
      tools.push({
        name,
        description: operation.summary ?? `${method.toUpperCase()} ${path}`,
        inputSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
      });
      routes.set(name, { method: method === "get" ? "GET" : "POST", path, query: parameters.map((p) => p.name), required, hasBody: operation.requestBody !== undefined });
    }
  }
  return { tools, routes };
}

const runReviewTool: Tool = {
  name: "run_review",
  description:
    "Run one Tradeflow review through POST /run: explain_week, thesis_check, pre_trade, reconcile or briefing. With no task, the Router picks one from the question. It never saves a trade or changes the ledger; a review that needs the owner ends with status needs_human.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", enum: REVIEW_TASKS, description: "Omit it to let the Router choose from the question." },
      question: { type: "string", description: "Required for explain_week; the Router reads it when task is missing." },
      as_of: { type: "string", format: "date", description: "A date as YYYY-MM-DD. Default: the last session in the data." },
      trade: {
        type: "object",
        description: "pre_trade only: the trade to review. Nothing is saved.",
        required: ["symbol", "side", "quantity"],
        properties: { symbol: { type: "string" }, side: { enum: ["buy", "sell"] }, quantity: { type: "integer", minimum: 1 }, price: { type: "number" } },
      },
      run_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$", description: "Optional id for the run; GET /run/<run_id> returns its trace." },
    },
  },
};

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

/** One fetch with a timeout. A failure becomes an error result: a tool call never throws. */
async function request(url: string, init: RequestInit, timeoutMs: number, onTimeout: string): Promise<CallToolResult> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return response.ok ? text(body) : text(`HTTP ${response.status}: ${body}`, true);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return text(`No reply within ${timeoutMs} ms. ${onTimeout}`, true);
    return text(`Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}. Start the app with npm run dev -- -p 8000.`, true);
  }
}

function callRoute(route: Route, args: Json): Promise<CallToolResult> | CallToolResult {
  const missing = route.required.filter((name) => args[name] === undefined || args[name] === null);
  if (missing.length > 0) return text(`Missing required argument: ${missing.join(", ")}.`, true);
  if (route.hasBody) {
    return request(`${baseUrl}${route.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }, CALL_TIMEOUT_MS, "The request may still be running.");
  }
  const unknown = Object.keys(args).filter((name) => !route.query.includes(name));
  if (unknown.length > 0) return text(`Unknown argument: ${unknown.join(", ")}.`, true);
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(args)) if (value !== undefined && value !== null) query.set(name, String(value));
  const suffix = query.toString() === "" ? "" : `?${query}`;
  return request(`${baseUrl}${route.path}${suffix}`, { method: "GET" }, CALL_TIMEOUT_MS, "The request may still be running.");
}

function callRunReview(args: Json): Promise<CallToolResult> | CallToolResult {
  const { run_id: runId, ...input } = args;
  const task = input.task;
  if (task !== undefined && task !== null && (typeof task !== "string" || !REVIEW_TASKS.includes(task))) {
    return text(`task must be one of ${REVIEW_TASKS.join(", ")}. An approval or a correction is made by the owner in the Explain page, never by a tool.`, true);
  }
  const timeoutMs = (task === "briefing" ? msFromEnv("BRIEFING_TIMEOUT_MS", 1_200_000) : msFromEnv("RUN_TIMEOUT_MS", 600_000)) + RUN_MARGIN_MS;
  const body = JSON.stringify({ ...(runId === undefined ? {} : { run_id: runId }), input });
  return request(`${baseUrl}/run`, { method: "POST", headers: { "content-type": "application/json" }, body }, timeoutMs, "The run may still be going: read GET /run/<run_id> for its trace.");
}

async function main(): Promise<void> {
  let doc: OpenApi;
  try {
    const response = await fetch(`${baseUrl}/api/openapi.json`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    doc = (await response.json()) as OpenApi;
  } catch (error) {
    log(`Could not read ${baseUrl}/api/openapi.json: ${error instanceof Error ? error.message : String(error)}. Start the app with npm run dev -- -p 8000, or set TRADEFLOW_URL.`);
    process.exit(1);
  }

  const { tools, routes } = buildTools(doc);
  const allTools = [...tools, runReviewTool];
  const server = new Server({ name: "tradeflow", version: doc.info?.version ?? "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const { name } = call.params;
    const args = (call.params.arguments ?? {}) as Json;
    log(`call ${name}`);
    if (name === runReviewTool.name) return callRunReview(args);
    const route = routes.get(name);
    return route ? callRoute(route, args) : text(`Unknown tool ${name}.`, true);
  });

  await server.connect(new StdioServerTransport());
  log(`ready: ${allTools.length} tools from ${baseUrl}`);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
