/**
 * Auth Service (Control Layer)
 * 
 * Orchestrates authentication business logic including registration,
 * email verification, password reset, and credential validation.
 * 
 * BCE: This service sits between the Boundary (API routes) and
 * Entity (repositories) layers. It coordinates multiple repositories
 * and the email service to execute auth workflows.
 * 
 * Security:
 * - Passwords hashed with bcrypt (12 salt rounds)
 * - Tokens generated with crypto.randomBytes (32 bytes)
 * - Password reset silently succeeds for non-existent emails
 *   to prevent email enumeration attacks
 */
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { UserRepository } from "@/repositories/user.repository";
import { TokenRepository } from "@/repositories/token.repository";
import { EmailService } from "@/services/email.service";
import type { RegisterInput, ResetPasswordInput } from "@/lib/validations";

export class AuthService {
  private userRepo = new UserRepository();
  private tokenRepo = new TokenRepository();
  private emailService = new EmailService();

  /**
   * Registers a new user:
   * 1. Check for duplicate email
   * 2. Hash password with bcrypt
   * 3. Create user record (unverified)
   * 4. Generate and store verification token
   * 5. Send verification email
   */
  async register(input: RegisterInput) {
    const existing = await this.userRepo.findByEmail(input.email);
    if (existing) {
      throw new Error("Email already registered");
    }

    const hashedPassword = await bcrypt.hash(input.password, 12);

    const user = await this.userRepo.create({
      name: input.name,
      email: input.email,
      hashedPassword,
    });

    const token = crypto.randomBytes(32).toString("hex");
    await this.tokenRepo.createVerificationToken(input.email, token);
    const delivery = await this.emailService.sendVerificationEmail(input.email, token);

    return { user, emailSent: delivery.sent };
  }

  /**
   * Verifies a user's email using the provided token.
   * Checks token validity and expiry, then sets emailVerified timestamp.
   * Token is deleted after successful verification (single use).
   */
  async verifyEmail(token: string) {
    const verificationToken =
      await this.tokenRepo.findVerificationToken(token);

    if (!verificationToken || verificationToken.expires < new Date()) {
      throw new Error("Invalid or expired token");
    }

    const user = await this.userRepo.findByEmail(
      verificationToken.identifier
    );
    if (!user) {
      throw new Error("User not found");
    }

    await this.tokenRepo.deleteVerificationToken(token);
    return this.userRepo.verifyEmail(user.id);
  }

  /**
   * Initiates password reset flow.
   * Silently succeeds for non-existent emails to prevent
   * email enumeration attacks (security best practice).
   */
  async requestPasswordReset(email: string) {
    const user = await this.userRepo.findByEmail(email);
    if (!user) return;

    const token = crypto.randomBytes(32).toString("hex");
    await this.tokenRepo.createPasswordResetToken(email, token);
    await this.emailService.sendPasswordResetEmail(email, token);
  }

  /**
   * Completes password reset:
   * 1. Validate token exists and hasn't expired
   * 2. Find user by email stored in token
   * 3. Hash new password and update user record
   * 4. Delete used token (single use)
   */
  async resetPassword(input: ResetPasswordInput) {
    const resetToken = await this.tokenRepo.findPasswordResetToken(
      input.token
    );

    if (!resetToken || resetToken.expires < new Date()) {
      throw new Error("Invalid or expired token");
    }

    const user = await this.userRepo.findByEmail(resetToken.email);
    if (!user) {
      throw new Error("User not found");
    }

    const hashedPassword = await bcrypt.hash(input.password, 12);
    await this.userRepo.updateProfile(user.id, { hashedPassword });
    await this.tokenRepo.deletePasswordResetToken(input.token);

    return user;
  }

  /**
   * Validates login credentials.
   * Returns the user if email exists and password matches, null otherwise.
   * Used by NextAuth's authorize callback.
   */
  async validateCredentials(email: string, password: string) {
    const user = await this.userRepo.findByEmail(email);
    if (!user) return null;

    const isValid = await bcrypt.compare(password, user.hashedPassword);
    if (!isValid) return null;

    return user;
  }
}
