import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";

const API_DIR = path.join(process.cwd(), "src", "app", "api");

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : Promise.resolve(e.name === "route.ts" ? [path.join(dir, e.name)] : []))),
  );
  return nested.flat();
}

describe("openapi document", () => {
  it("describes every route and method under src/app/api", async () => {
    const files = await routeFiles(API_DIR);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const route = "/api/" + path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
      const source = await readFile(file, "utf8");
      const methods = [...source.matchAll(/export (?:async )?function (GET|POST)\b/g)].map((m) => m[1].toLowerCase());
      expect(openApiDocument.paths[route], route).toBeDefined();
      for (const m of methods) expect(openApiDocument.paths[route]?.[m as "get" | "post"], `${m} ${route}`).toBeDefined();
    }
  });

  it("documents only routes that exist", async () => {
    const files = await routeFiles(API_DIR);
    const routes = new Set(files.map((f) => "/api/" + path.relative(API_DIR, path.dirname(f)).split(path.sep).join("/")));
    for (const p of Object.keys(openApiDocument.paths)) expect(routes.has(p), p).toBe(true);
  });
});
