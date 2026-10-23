// The MCP server's request against a stub app on an ephemeral port of 127.0.0.1: no real app and no model.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "./mcp-request";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/run") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ run_id: "r1", status: "success" }));
      }, 2000);
    } else {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    }
  });
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

describe("the MCP server's request", () => {
  it("waits for a run that answers after 2 s and returns its reply", async () => {
    const result = await request(`${base}/run`, post, 10_000, "The run may still be going.", base);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ run_id: "r1", status: "success" });
  }, 10_000);

  it("gives an error result when its own timeout passes first", async () => {
    const result = await request(`${base}/run`, post, 200, "The run may still be going.", base);
    expect(result).toEqual({ content: [{ type: "text", text: "No reply within 200 ms. The run may still be going." }], isError: true });
  });

  it("gives an error result with the status and body for an HTTP error", async () => {
    const result = await request(`${base}/other`, { method: "GET" }, 5_000, "", base);
    expect(result).toEqual({ content: [{ type: "text", text: "HTTP 500: boom" }], isError: true });
  });

  it("gives a could-not-reach error result when nothing listens", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await request(`${url}/run`, post, 5_000, "", url);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^Could not reach http:\/\/127\.0\.0\.1:\d+: fetch failed\./);
  });
});
