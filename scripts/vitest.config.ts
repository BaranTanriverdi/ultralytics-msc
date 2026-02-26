import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "src/**/*.{spec,test}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/live/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
  resolve: {
    alias: [
      {
        find: /^lib\/(.*)$/,
        replacement: resolve(__dirname, "../lib/$1"),
      },
      {
        find: /^scripts\/(.*)$/,
        replacement: resolve(__dirname, "src/$1"),
      },
    ],
  },
});
