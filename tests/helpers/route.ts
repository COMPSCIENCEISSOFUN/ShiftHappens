/**
 * Request/response helpers for calling App Router handlers directly.
 *
 * Route handlers are plain async functions — `(request, { params })` — so they
 * can be imported and invoked without an HTTP server. Two details matter:
 *
 * 1. Next.js 16 makes `params` a PROMISE. Passing a plain object type-checks
 *    against a loose signature but produces `undefined` for every param at
 *    runtime, which surfaces as a confusing 404 or 500 rather than an obvious
 *    error. `ctx()` exists so no test can get that wrong.
 *
 * 2. These tests must run under the `node` environment, not the project-wide
 *    `jsdom`, because jsdom does not provide the `Request`/`Response`/`Headers`
 *    globals that `NextRequest` extends. Every file in tests/api/ therefore
 *    carries `// @vitest-environment node` as its first line.
 */
import { NextRequest } from "next/server";

const BASE = "http://localhost:3000";

/** The `{ params }` context argument, with params correctly wrapped in a Promise. */
export function ctx<T extends Record<string, string>>(params: T = {} as T) {
  return { params: Promise.resolve(params) };
}

/**
 * A GET request. `query` is appended as a query string — several routes read
 * `searchParams`, and the assignments group reads `orgId` from there rather
 * than from the path.
 */
export function req(
  path = "/api/test",
  query: Record<string, string | number | undefined> = {}
) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return new NextRequest(url, { method: "GET" });
}

/** A request with a JSON body, for POST/PATCH/PUT/DELETE. */
export function jsonReq(
  method: string,
  body: unknown = {},
  path = "/api/test",
  query: Record<string, string | number | undefined> = {}
) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Builds the right request shape for a method without the caller thinking about
 * it. GET and DELETE carry no body; everything else gets a JSON one.
 */
export function requestFor(
  method: string,
  options: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    path?: string;
  } = {}
) {
  const { body = {}, query = {}, path = "/api/test" } = options;
  if (method === "GET" || method === "DELETE") return req(path, query);
  return jsonReq(method, body, path, query);
}

/** Reads a JSON body defensively — a non-JSON error page must not throw here. */
export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
