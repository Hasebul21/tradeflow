// The MCP server's one request to the running app, apart so tests can call it. It goes through httpFetch
// (src/agent/http-fetch.ts), not Node's fetch: Node's fetch stops waiting for headers after 300 s, so a run_review
// that ran longer failed the tool call with "fetch failed" while the run kept going. The caller's timeout decides.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { httpFetch } from "../src/agent/http-fetch";

export const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

/** One request with a timeout. A failure becomes an error result: a tool call never throws. `baseUrl` names the app in the error. */
export async function request(url: string, init: RequestInit, timeoutMs: number, onTimeout: string, baseUrl: string): Promise<CallToolResult> {
  try {
    const response = await httpFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return response.ok ? text(body) : text(`HTTP ${response.status}: ${body}`, true);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return text(`No reply within ${timeoutMs} ms. ${onTimeout}`, true);
    return text(`Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}. Start the app with npm run dev -- -p 8000.`, true);
  }
}
