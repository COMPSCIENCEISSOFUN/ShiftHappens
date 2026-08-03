import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
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
    /**
     * Node by default; the handful of files that render React opt in with a
     * `// @vitest-environment jsdom` docblock.
     *
     * jsdom was the global default, so all ~99 files paid to have a DOM
     * constructed whether they touched one or not. Measured at ~65s of a ~255s
     * run — a quarter of the suite spent building browsers for tests that only
     * talk to Postgres.
     */
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    fileParallelism: false,
    reporters: ['verbose'],
    /**
     * Vitest defaults to 5s, which suits pure unit tests. This suite is not
     * one: every test hits a real database, several hash passwords at bcrypt
     * cost 12, and `tests/api/manifest-completeness.test.ts` imports every
     * route module in the app to check its exports.
     *
     * Measured on an idle machine, the slowest test uses ~3.6s of the 5s
     * budget. That leaves no headroom, so the run fails on a busy laptop —
     * building in another terminal is enough to do it — with a timeout that
     * says nothing about the code. Raised to give a 5x margin over the
     * slowest observed test. A genuine hang never terminates, so it still
     * fails; it just takes longer to say so.
     *
     * hookTimeout covers `beforeEach(cleanDatabase)`, which is 24 sequential
     * deletes and is subject to the same contention.
     */
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});