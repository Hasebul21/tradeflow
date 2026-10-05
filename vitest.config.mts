import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Mirror the tsconfig `@/*` -> `./src/*` alias so tests can import app modules. */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
