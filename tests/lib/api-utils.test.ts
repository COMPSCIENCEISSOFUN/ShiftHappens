/**
 * Shared API response helpers.
 *
 * `validationErrorResponse` exists because clients render `error` and ignore
 * `details`. A bare "Validation failed" reaches the user with no clue what to
 * change, so the first issue's own message is promoted into `error`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { handleApiError, validationErrorResponse } from "@/lib/api-utils";

afterEach(() => vi.restoreAllMocks());

/** Runs a schema and returns the ZodError, failing the test if it parses. */
function errorFrom(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected the schema to reject this input");
  return result.error;
}

describe("handleApiError", () => {
  it("returns a 500 with a generic body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(new Error("connection refused"), "Tasks GET");

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
  });

  it("never leaks the underlying message to the client", async () => {
    // The log is for us; the body is for whoever is calling. A stack trace or a
    // connection string in the response is an information leak.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(
      new Error("postgres://user:hunter2@db:5432 refused"),
      "Tasks GET"
    );

    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });

  it("logs with the context so the entry is findable", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    handleApiError(new Error("boom"), "Tasks GET");

    expect(spy).toHaveBeenCalledWith(
      "[API Error] Tasks GET:",
      expect.any(Error)
    );
  });

  it("handles a thrown non-Error without itself throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => handleApiError("just a string", "Tasks GET")).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe("validationErrorResponse", () => {
  const schema = z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
  });

  it("returns a 400", () => {
    expect(validationErrorResponse(errorFrom(schema, {})).status).toBe(400);
  });

  it("promotes the first issue's message into `error`", async () => {
    const res = validationErrorResponse(errorFrom(schema, { email: "nope", password: "longenough" }));

    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid email address",
    });
  });

  it("names the offending field so a form can highlight it", async () => {
    const res = validationErrorResponse(errorFrom(schema, { email: "nope", password: "longenough" }));
    const body = await res.json();

    expect(body.field).toBe("email");
  });

  it("still includes per-field details", async () => {
    const body = await validationErrorResponse(errorFrom(schema, {})).json();

    expect(body.details.fieldErrors).toHaveProperty("email");
    expect(body.details.fieldErrors).toHaveProperty("password");
  });

  it("joins a nested path with dots", async () => {
    const nested = z.object({ user: z.object({ name: z.string() }) });
    const body = await validationErrorResponse(errorFrom(nested, { user: {} })).json();

    expect(body.field).toBe("user.name");
  });

  it("omits `field` when the issue has no path", async () => {
    // A whole-object refinement has an empty path; "" would read as a field
    // named empty string and could make a form highlight nothing.
    const refined = z
      .object({ a: z.number() })
      .refine((v) => v.a > 0, { message: "Must be positive" });
    const body = await validationErrorResponse(errorFrom(refined, { a: -1 })).json();

    expect(body.field).toBeUndefined();
  });
});
