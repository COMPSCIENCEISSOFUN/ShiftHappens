// @vitest-environment node
/**
 * Keeps the manifest honest.
 *
 * A hand-maintained table of routes is worthless the moment someone adds a
 * route and forgets to declare it — worse than worthless, because the contract
 * suite will report full coverage while silently skipping the new endpoint.
 *
 * This file closes that loop from both directions:
 *
 *   • every route file on disk must be declared in the manifest
 *   • every manifest entry must correspond to a real file, with that method
 *     actually exported
 *
 * The first direction is the one that matters. It means a new route cannot be
 * merged without someone deciding, in writing, who is allowed to call it.
 *
 * It also catches a failure that has already happened on this project once:
 * `my-certifications/route.ts` was written but never landed in the working
 * tree. `npm test` passed and `npm run build` passed, because Next simply
 * enumerates the files that exist — a missing route is not an error. It was
 * caught by eye, in the build output. This test would have failed immediately.
 */
import { describe, it, expect, vi } from "vitest";

/**
 * Required even though this file asserts nothing about authentication.
 *
 * Importing any route pulls in `@/lib/auth-guard` → `@/lib/auth` → the real
 * `next-auth`, whose `lib/env.js` does a bare `import "next/server"`. Next's own
 * bundler resolves that; Vitest's node resolver does not, and every import fails
 * with `Cannot find module 'next/server'`.
 *
 * Stubbing `@/lib/auth` cuts the chain before next-auth loads. The other files
 * in tests/api/ mock it for behavioural reasons and got this for free — this one
 * needs it purely to make the modules loadable.
 *
 * `handlers` is stubbed as well as `auth` because this is the only file that
 * imports EVERY route, including `auth/[...nextauth]/route.ts`, whose entire
 * body is `export const { GET, POST } = handlers`. Without it that destructure
 * yields undefined and the module fails to load. Note the check still has teeth
 * there: it verifies the route file exports GET and POST, which is what would
 * break if the file were deleted or the export renamed.
 *
 * If a route is ever added that imports another binding from `@/lib/auth`, this
 * test fails with that binding named — no guesswork required.
 */
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  handlers: { GET: vi.fn(), POST: vi.fn() },
}));

import { ROUTES, DECLARED_PATHS, type RouteSpec } from "./routes.manifest";

const MODULES = import.meta.glob("../../src/app/api/**/route.ts");

/** "../../src/app/api/organizations/[orgId]/tasks/route.ts" → "organizations/[orgId]/tasks" */
function toRoutePath(globKey: string): string {
  return globKey
    .replace("../../src/app/api/", "")
    .replace(/\/route\.ts$/, "");
}

const FILE_PATHS = Object.keys(MODULES).map(toRoutePath).sort();

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

describe("route manifest completeness", () => {
  it("finds route files to check (guards against a broken glob)", () => {
    // If the glob pattern ever stops matching, every assertion below would pass
    // vacuously. This is the canary.
    expect(FILE_PATHS.length).toBeGreaterThan(50);
  });

  it("declares every route file that exists on disk", () => {
    const undeclared = FILE_PATHS.filter((p) => !DECLARED_PATHS.has(p));

    expect(
      undeclared,
      undeclared.length
        ? `\n\n${undeclared.length} route file(s) exist but are not declared in routes.manifest.ts:\n` +
            undeclared.map((p) => `  • ${p}`).join("\n") +
            `\n\nAdd an entry stating who may call each one. This is not optional — ` +
            `an undeclared route is an untested route.\n`
        : undefined
    ).toEqual([]);
  });

  it("has no manifest entry pointing at a file that does not exist", () => {
    const fileSet = new Set(FILE_PATHS);
    const orphans = [...DECLARED_PATHS].filter((p) => !fileSet.has(p));

    expect(
      orphans,
      orphans.length
        ? `\n\n${orphans.length} manifest entr(ies) reference a missing route file:\n` +
            orphans.map((p) => `  • ${p}`).join("\n") +
            `\n\nEither the file was deleted and the entry should go, or the file ` +
            `was never delivered to the working tree.\n`
        : undefined
    ).toEqual([]);
  });

  it("declares a method that the module actually exports", async () => {
    const mismatches: string[] = [];

    for (const spec of ROUTES) {
      const key = `../../src/app/api/${spec.path}/route.ts`;
      const loader = MODULES[key];
      if (!loader) continue; // reported by the previous test

      let mod: Record<string, unknown>;
      try {
        mod = (await (loader as () => Promise<Record<string, unknown>>)()) ?? {};
      } catch (error) {
        mismatches.push(
          `${spec.method} ${spec.path} — module failed to import: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }

      if (typeof mod[spec.method] !== "function") {
        mismatches.push(`${spec.method} ${spec.path} — not exported`);
      }
    }

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("does not declare a method the module exports but the manifest omits", async () => {
    const missing: string[] = [];

    for (const path of FILE_PATHS) {
      const loader = MODULES[`../../src/app/api/${path}/route.ts`];
      let mod: Record<string, unknown>;
      try {
        mod = (await (loader as () => Promise<Record<string, unknown>>)()) ?? {};
      } catch {
        continue; // import failures are reported above
      }

      for (const method of HTTP_METHODS) {
        if (typeof mod[method] !== "function") continue;
        const declared = ROUTES.some(
          (r: RouteSpec) => r.path === path && r.method === method
        );
        if (!declared) missing.push(`${method} /api/${path}`);
      }
    }

    expect(
      missing,
      missing.length
        ? `\n\n${missing.length} exported handler(s) are not declared in the manifest:\n` +
            missing.map((m) => `  • ${m}`).join("\n") + "\n"
        : undefined
    ).toEqual([]);
  });

  it("gives every entry a coherent auth declaration", () => {
    const problems: string[] = [];

    for (const spec of ROUTES) {
      if (spec.orgScoped && spec.auth !== "session") {
        problems.push(`${spec.method} ${spec.path}: orgScoped but auth is "${spec.auth}"`);
      }
      if (spec.roles && spec.auth !== "session") {
        problems.push(`${spec.method} ${spec.path}: declares roles but auth is "${spec.auth}"`);
      }
      if (spec.suspension && !spec.orgScoped) {
        problems.push(`${spec.method} ${spec.path}: suspension gate without an org scope`);
      }
      if (spec.orgIdInQuery && !spec.orgScoped) {
        problems.push(`${spec.method} ${spec.path}: orgIdInQuery without an org scope`);
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("has no duplicate (path, method) pairs", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const spec of ROUTES) {
      const key = `${spec.method} ${spec.path}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates, duplicates.join("\n")).toEqual([]);
  });
});
