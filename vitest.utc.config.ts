/**
 * Vitest config for running the suite as if on the production server.
 *
 * Vercel runs on UTC; developer machines here run on Asia/Singapore. Any code
 * that reads a wall-clock time from the ambient clock therefore behaves
 * differently in production than it does locally — and the default suite, run
 * in Singapore, agrees with the buggy code and passes. That is exactly how the
 * eligibility engine shipped while marking every casual employee unavailable.
 *
 * TZ is set through `test.env` rather than by assigning process.env here:
 * ES imports are hoisted, so a top-level assignment in this file would run
 * AFTER ./vitest.config had already been evaluated, and would not reliably
 * reach the worker processes that actually execute the tests.
 *
 * Usage: npm run test:utc
 */
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      env: { TZ: "UTC" },
    },
  })
);
