/**
 * Tests for Token Repository (Entity Layer)
 * Verifies creation, lookup, and deletion of verification
 * and password reset tokens against a real PostgreSQL database.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TokenRepository } from "@/repositories/token.repository";
import { cleanDatabase } from "../helpers/cleanup";

const tokenRepo = new TokenRepository();

beforeEach(async () => {
  await cleanDatabase();
});

describe("TokenRepository", () => {
  describe("createVerificationToken", () => {
    it("creates a verification token", async () => {
      const token = await tokenRepo.createVerificationToken(
        "john@example.com",
        "abc123"
      );

      expect(token.identifier).toBe("john@example.com");
      expect(token.token).toBe("abc123");
      expect(token.expires).toBeInstanceOf(Date);
    });
  });

  describe("findVerificationToken", () => {
    it("finds a valid token", async () => {
      await tokenRepo.createVerificationToken("john@example.com", "abc123");

      const found = await tokenRepo.findVerificationToken("abc123");
      expect(found).not.toBeNull();
      expect(found!.identifier).toBe("john@example.com");
    });

    it("returns null for non-existent token", async () => {
      const found = await tokenRepo.findVerificationToken("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("deleteVerificationToken", () => {
    it("deletes a token", async () => {
      await tokenRepo.createVerificationToken("john@example.com", "abc123");
      await tokenRepo.deleteVerificationToken("abc123");

      const found = await tokenRepo.findVerificationToken("abc123");
      expect(found).toBeNull();
    });
  });

  describe("createPasswordResetToken", () => {
    it("creates a password reset token", async () => {
      const token = await tokenRepo.createPasswordResetToken(
        "john@example.com",
        "reset123"
      );

      expect(token.email).toBe("john@example.com");
      expect(token.token).toBe("reset123");
    });
  });

  describe("findPasswordResetToken", () => {
    it("finds a valid token", async () => {
      await tokenRepo.createPasswordResetToken("john@example.com", "reset123");

      const found = await tokenRepo.findPasswordResetToken("reset123");
      expect(found).not.toBeNull();
      expect(found!.email).toBe("john@example.com");
    });
  });

  describe("deletePasswordResetToken", () => {
    it("deletes a token", async () => {
      await tokenRepo.createPasswordResetToken("john@example.com", "reset123");
      await tokenRepo.deletePasswordResetToken("reset123");

      const found = await tokenRepo.findPasswordResetToken("reset123");
      expect(found).toBeNull();
    });
  });
});
