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

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

// A real class, not vi.fn() — Vitest 4 does not mock class constructors via
// mockImplementation, and the service calls `new Resend(...)`.
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
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

/*
 * Which provider the service picks is decided from the environment, and the
 * developer running these tests has real GMAIL_* values in `.env` — so without
 * this every Resend assertion below would quietly exercise the Gmail path and
 * fail on a mock that was never called.
 *
 * Stated per test rather than assumed, since the file now covers both.
 */
const ENV_KEYS = [
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
] as const;
let savedEnv: Record<string, string | undefined>;

function useResend() {
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  process.env.RESEND_API_KEY = "re_test_key";
}

function useGmail() {
  process.env.GMAIL_USER = "noreply@example.com";
  process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  mocks.send.mockReset();
  mocks.sendMail.mockReset();
  mocks.sendMail.mockResolvedValue({ messageId: "test" });
  mocks.createTransport.mockReset();
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  useResend();
  // The config does not set restoreMocks, so a leaked spy would silence
  // console.error for every later test in this file.
  errorSpy = silenceConsoleError();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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

    // The provider is named because there are now two of them, and "which one
    // failed" is the first thing you need from the log line.
    expect(logged()).toContain("Resend");
    expect(logged()).toContain("Missing API key.");
  });
});

/**
 * Provider selection.
 *
 * Gmail exists because Resend will not deliver to anyone but the account owner
 * until a domain is verified, and verifying a domain means owning one. These
 * pin the rule that decides between them, and the one piece of input handling
 * that is easy to get wrong.
 */
describe("choosing a provider", () => {
  it("prefers Gmail when both are configured", async () => {
    useGmail();

    await service.sendVerificationEmail("a@b.com", "tok");

    expect(mocks.sendMail).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("falls back to Resend when Gmail is not configured", async () => {
    mocks.send.mockResolvedValue({ data: { id: "1" }, error: null });

    await service.sendVerificationEmail("a@b.com", "tok");

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("reports having nowhere to send rather than failing silently", async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.RESEND_API_KEY;

    await expect(service.sendVerificationEmail("a@b.com", "tok")).resolves.toBe(
      false
    );
    expect(logged()).toContain("no email provider configured");
  });

  it("sends from the Gmail account, with the product as the display name", async () => {
    useGmail();

    await service.sendVerificationEmail("a@b.com", "tok");

    expect(mocks.sendMail.mock.calls[0][0].from).toBe(
      "ShiftHappens <noreply@example.com>"
    );
  });

  /*
   * Google displays an app password as four space-separated groups and it is
   * almost always pasted that way. SMTP AUTH rejects it with the spaces intact
   * and answers "Username and Password not accepted", which reads as a wrong
   * password rather than a formatting problem — so the fix is invisible from
   * the error and you go back to Google for another one that fails the same
   * way. Asserted through a real send because the helper is not exported.
   */
  it("strips the spaces Google puts in an app password", async () => {
    // Credentials unique to this test. The transport is cached across sends and
    // keyed on the credentials, so reusing `useGmail()` here would be answered
    // from the cache and `createTransport` would never run.
    process.env.GMAIL_USER = "strip-test@example.com";
    process.env.GMAIL_APP_PASSWORD = "aaaa bbbb cccc dddd";

    await service.sendVerificationEmail("a@b.com", "tok");

    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: "strip-test@example.com", pass: "aaaabbbbccccdddd" },
      })
    );
  });

  it("reuses one connection rather than dialling per message", async () => {
    process.env.GMAIL_USER = "pool-test@example.com";
    process.env.GMAIL_APP_PASSWORD = "pool pool pool pool";

    await service.sendVerificationEmail("a@b.com", "tok");
    const afterFirst = mocks.createTransport.mock.calls.length;
    await service.sendVerificationEmail("c@d.com", "tok");

    expect(mocks.createTransport.mock.calls.length).toBe(afterFirst);
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
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
