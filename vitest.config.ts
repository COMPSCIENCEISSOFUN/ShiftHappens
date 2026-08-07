import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.test", override: true });

/**
 * Refuse to run against anything but the test database.
 *
 * dotenv.config() fails silently when the file is missing — on a fresh clone,
 * or if .env.test did not travel between machines, DATABASE_URL falls through
 * to .env, which points at the DEVELOPMENT database. The suite would then run
 * normally and cleanDatabase() would truncate every table in it, with no
 * warning and nothing to roll back to.
 */
if (!process.env.DATABASE_URL?.includes("_test")) {
  throw new Error(
    "Refusing to run tests: DATABASE_URL does not name a *_test database.\n" +
      "Every test truncates the whole schema, so this would wipe your " +
      "development data.\n" +
      "Check that .env.test exists in the project root and sets DATABASE_URL."
  );
}

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
