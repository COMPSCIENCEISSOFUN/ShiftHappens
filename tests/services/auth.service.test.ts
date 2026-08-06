/**
 * Tests for Auth Service (Control Layer)
 * Verifies registration, email verification, password reset,
 * and credential validation. EmailService is mocked to avoid
 * external API calls during testing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuthService } from "@/services/auth.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const authService = new AuthService();

vi.mock("@/services/email.service", () => ({
  EmailService: class {
    sendVerificationEmail = vi.fn().mockResolvedValue(undefined);
    sendPasswordResetEmail = vi.fn().mockResolvedValue(undefined);
    sendDuplicateRegistrationEmail = vi.fn().mockResolvedValue(undefined);
  },
}));

beforeEach(async () => {
  await cleanDatabase();
});

describe("AuthService", () => {
  describe("register", () => {
    it("creates a user and sends verification email", async () => {
      const result = await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      expect(result.user!.email).toBe("john@example.com");
      expect(result.user!.name).toBe("John Doe");
      expect(result.user!.emailVerified).toBeNull();
    });

    /*
     * It used to throw "Email already registered", which the route turned into
     * a 409 — handing an unauthenticated caller the fact that
     * `requestPasswordReset` refuses to disclose. Registration now answers the
     * same way either way; the difference is only that no second account exists
     * and the account holder gets told somebody tried.
     */
    it("does not say when an email is already taken", async () => {
      await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      const second = await authService.register({
        name: "Jane Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      expect(second.created).toBe(false);
      expect(second.user).toBeNull();
    });

    it("creates no second account, and leaves the first one alone", async () => {
      await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });
      await authService.register({
        name: "Jane Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      const users = await prisma.user.findMany({
        where: { email: "john@example.com" },
      });
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe("John Doe");
    });

    it("hashes the password", async () => {
      const result = await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      expect(result.user!.hashedPassword).not.toBe("SecurePass1!");
      expect(result.user!.hashedPassword.length).toBeGreaterThan(0);
    });
  });

  describe("verifyEmail", () => {
    it("verifies a user with a valid token", async () => {
      const { user } = await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      const token = await prisma.verificationToken.findFirst({
        where: { identifier: "john@example.com" },
      });

      const verified = await authService.verifyEmail(token!.token);
      expect(verified.emailVerified).not.toBeNull();
    });

    it("throws for invalid token", async () => {
      await expect(authService.verifyEmail("invalid")).rejects.toThrow(
        "Invalid or expired token"
      );
    });
  });

  describe("requestPasswordReset", () => {
    it("creates a reset token for existing user", async () => {
      await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      await authService.requestPasswordReset("john@example.com");

      const token = await prisma.passwordResetToken.findFirst({
        where: { email: "john@example.com" },
      });
      expect(token).not.toBeNull();
    });

    it("does not throw for non-existent email", async () => {
      await expect(
        authService.requestPasswordReset("nobody@example.com")
      ).resolves.not.toThrow();
    });
  });

  describe("resetPassword", () => {
    it("resets password with valid token", async () => {
      await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      await authService.requestPasswordReset("john@example.com");

      const token = await prisma.passwordResetToken.findFirst({
        where: { email: "john@example.com" },
      });

      await authService.resetPassword({
        token: token!.token,
        password: "NewSecure1!",
        confirmPassword: "NewSecure1!",
      });

      const user = await prisma.user.findUnique({
        where: { email: "john@example.com" },
      });
      expect(user!.hashedPassword).not.toBe("SecurePass1!");
    });

    it("throws for invalid token", async () => {
      await expect(
        authService.resetPassword({
          token: "invalid",
          password: "NewSecure1!",
          confirmPassword: "NewSecure1!",
        })
      ).rejects.toThrow("Invalid or expired token");
    });
  });
});
/**
 * `requestPasswordReset` answers identically for known and unknown addresses —
 * that is the documented anti-enumeration control. But an identical response
 * only hides the answer if it also takes the same TIME.
 *
 * It did not. An unknown address returned the instant the user lookup missed;
 * a known one additionally waited on a token insert AND a full HTTPS round trip
 * to Resend. That is a consistent, measurable difference of hundreds of
 * milliseconds, and timing the endpoint separated registered addresses from
 * unregistered ones — defeating the exact control the method exists to provide.
 *
 * Asserting on wall-clock timing directly would be flaky. These assert the
 * behaviour that causes it instead: the send is dispatched but not awaited.
 */
describe("AuthService.requestPasswordReset — enumeration timing", () => {
  it("does not wait for the email provider before returning", async () => {
    await prisma.user.create({
      data: {
        name: "Known User",
        email: "known@example.com",
        hashedPassword: "hash",
      },
    });

    // A send that never settles. If the method awaited it, this test would
    // time out rather than pass.
    const service = new AuthService();
    const hang = vi
      .spyOn(
        (service as unknown as { emailService: { sendPasswordResetEmail: () => Promise<boolean> } })
          .emailService,
        "sendPasswordResetEmail"
      )
      .mockImplementation(() => new Promise<boolean>(() => {}));

    try {
      await expect(
        service.requestPasswordReset("known@example.com")
      ).resolves.toBeUndefined();
      expect(hang).toHaveBeenCalledOnce();
    } finally {
      hang.mockRestore();
    }
  });

  it("still creates the reset token for a known address", async () => {
    // The send being fire-and-forget must not cost the token — otherwise the
    // link in the email would never validate.
    await prisma.user.create({
      data: {
        name: "Known User",
        email: "known2@example.com",
        hashedPassword: "hash",
      },
    });

    await authService.requestPasswordReset("known2@example.com");

    const token = await prisma.passwordResetToken.findFirst({
      where: { email: "known2@example.com" },
    });
    expect(token).not.toBeNull();
  });

  it("creates no token and reveals nothing for an unknown address", async () => {
    await expect(
      authService.requestPasswordReset("nobody@example.com")
    ).resolves.toBeUndefined();

    expect(
      await prisma.passwordResetToken.count({ where: { email: "nobody@example.com" } })
    ).toBe(0);
  });

  it("does not fail the request when the provider errors", async () => {
    // A dead mail provider must not turn a deliberately silent endpoint into a
    // 500, which would itself reveal that the address exists.
    await prisma.user.create({
      data: {
        name: "Known User",
        email: "known3@example.com",
        hashedPassword: "hash",
      },
    });

    const service = new AuthService();
    const boom = vi
      .spyOn(
        (service as unknown as { emailService: { sendPasswordResetEmail: () => Promise<boolean> } })
          .emailService,
        "sendPasswordResetEmail"
      )
      .mockRejectedValue(new Error("provider down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        service.requestPasswordReset("known3@example.com")
      ).resolves.toBeUndefined();

      // Assert the LOG, not merely the absence of a throw. `void promise`
      // discards the value but not the rejection, so without an explicit
      // handler this would be an unhandled rejection rather than a logged one —
      // and "it did not throw" would pass either way.
      await new Promise((r) => setTimeout(r, 10));
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("[Password Reset] Email dispatch failed"),
        expect.anything()
      );
    } finally {
      boom.mockRestore();
      logged.mockRestore();
    }
  });
});
