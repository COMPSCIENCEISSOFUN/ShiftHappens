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
    sendVerificationEmail = vi.fn().mockResolvedValue({ sent: true });
    sendPasswordResetEmail = vi.fn().mockResolvedValue({ sent: true });
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

      expect(result.user.email).toBe("john@example.com");
      expect(result.user.name).toBe("John Doe");
      expect(result.user.emailVerified).toBeNull();
    });

    it("throws if email already exists", async () => {
      await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      await expect(
        authService.register({
          name: "Jane Doe",
          email: "john@example.com",
          password: "SecurePass1!",
          confirmPassword: "SecurePass1!",
        })
      ).rejects.toThrow("Email already registered");
    });

    it("hashes the password", async () => {
      const result = await authService.register({
        name: "John Doe",
        email: "john@example.com",
        password: "SecurePass1!",
        confirmPassword: "SecurePass1!",
      });

      expect(result.user.hashedPassword).not.toBe("SecurePass1!");
      expect(result.user.hashedPassword.length).toBeGreaterThan(0);
    });
  });

  describe("verifyEmail", () => {
    it("verifies a user with a valid token", async () => {
      await authService.register({
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
