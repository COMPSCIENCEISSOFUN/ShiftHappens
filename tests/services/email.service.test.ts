/**
 * Tests for EmailService failure reporting.
 *
 * These exist because of a failure that was invisible in production: the
 * Resend SDK returns `{ data: null, error }` instead of throwing, so the
 * service's `try/catch` never ran and a 403 from the sandbox sender produced
 * no log line anywhere. Registration returned 201 and told the user to check
 * an inbox that would never receive anything.
 *
 * The assertion that matters is not "it does not throw" — a bare `catch {}`
 * satisfies that, and that is precisely what shipped. It is that the failure
 * is *logged*. Same reasoning as the fire-and-forget audit-log tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

// A real class, not vi.fn() — Vitest 4 does not mock class constructors via
// mockImplementation, and the service calls `new Resend(...)`.
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

import { EmailService } from "@/services/email.service";

const service = new EmailService();

/** Inferred rather than annotated — `ReturnType<typeof vi.spyOn>` loses the
 *  console.error signature and breaks `next build`, which typechecks tests. */
function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}
let errorSpy: ReturnType<typeof silenceConsoleError>;

/** Shape of a real Resend API rejection. */
function resendError(message: string, statusCode = 403, name = "validation_error") {
  return { data: null, error: { name, statusCode, message } };
}

function logged(): string {
  return errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

beforeEach(() => {
  mocks.send.mockReset();
  // The config does not set restoreMocks, so a leaked spy would silence
  // console.error for every later test in this file.
  errorSpy = silenceConsoleError();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("failed sends are reported", () => {
  it("logs an API error instead of swallowing it", async () => {
    mocks.send.mockResolvedValue(resendError("Something went wrong"));

    await service.sendVerificationEmail("someone@example.com", "tok");

    expect(errorSpy).toHaveBeenCalled();
    expect(logged()).toContain("someone@example.com");
    expect(logged()).toContain("Something went wrong");
  });

  it("names which email failed", async () => {
    mocks.send.mockResolvedValue(resendError("nope"));

    await service.sendInvitationEmail("a@b.com", "tok", "Ocean Grill", "Darryn");
    expect(logged()).toContain("invitation");

    errorSpy.mockClear();
    await service.sendPasswordResetEmail("a@b.com", "tok");
    expect(logged()).toContain("password reset");
  });

  it("includes the status code", async () => {
    mocks.send.mockResolvedValue(resendError("nope", 422));

    await service.sendVerificationEmail("a@b.com", "tok");

    expect(logged()).toContain("422");
  });

  /**
   * The project's actual misconfiguration. Resend's shared sender only
   * delivers to the account owner, and the raw message does not say what to
   * change — so the service adds the sentence that does.
   */
  it("explains the sandbox-sender restriction", async () => {
    mocks.send.mockResolvedValue(
      resendError("You can only send testing emails to your own email address.")
    );

    await service.sendVerificationEmail("someone-else@example.com", "tok");

    expect(logged()).toMatch(/sandbox/i);
    expect(logged()).toContain("RESEND_FROM_EMAIL");
  });

  it("reports a client that cannot be constructed", async () => {
    mocks.send.mockRejectedValue(new Error("Missing API key."));

    await service.sendVerificationEmail("a@b.com", "tok");

    expect(logged()).toContain("Resend client unavailable");
  });
});

describe("sending never breaks the caller", () => {
  it("resolves rather than throwing when the provider fails", async () => {
    mocks.send.mockResolvedValue(resendError("down"));

    // Registration must not roll back because email is unavailable.
    await expect(
      service.sendVerificationEmail("a@b.com", "tok")
    ).resolves.toBe(false);
  });

  it("resolves false on a thrown client error too", async () => {
    mocks.send.mockRejectedValue(new Error("Missing API key."));

    await expect(service.sendVerificationEmail("a@b.com", "tok")).resolves.toBe(
      false
    );
  });
});

describe("successful sends", () => {
  beforeEach(() => {
    mocks.send.mockResolvedValue({ data: { id: "abc" }, error: null });
  });

  it("logs nothing", async () => {
    await service.sendVerificationEmail("a@b.com", "tok");

    // Unexpected noise only stands out if expected noise is absent.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reports success to the caller", async () => {
    await expect(service.sendVerificationEmail("a@b.com", "tok")).resolves.toBe(
      true
    );
  });

  it("sends the verification link, not just any email", async () => {
    await service.sendVerificationEmail("a@b.com", "the-token");

    const payload = mocks.send.mock.calls[0][0];
    expect(payload.to).toBe("a@b.com");
    expect(payload.subject).toContain("Verify your email");
    expect(payload.html).toContain("the-token");
  });
});
