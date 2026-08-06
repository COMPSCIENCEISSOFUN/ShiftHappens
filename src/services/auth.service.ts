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
    /*
     * Hashed BEFORE the lookup, so both outcomes pay for it.
     *
     * bcrypt at cost 12 is the expensive step here by an order of magnitude.
     * Doing it only on the create path would make "already registered" return
     * measurably faster, which reopens by stopwatch the question the response
     * body no longer answers.
     */
    const hashedPassword = await bcrypt.hash(input.password, 12);

    const existing = await this.userRepo.findByEmail(input.email);
    if (existing) {
      /*
       * No throw, and no user created.
       *
       * This raised "Email already registered", which the route turned into a
       * 409 — handing an unauthenticated caller exactly the fact that
       * `requestPasswordReset` below goes to deliberate lengths to hide. A list
       * of a company's addresses posted here separated the real ones from the
       * invented ones, and confirmed them for credential stuffing.
       *
       * The account holder is told instead, so the attempt is not silent to the
       * one person entitled to know about it. Fire-and-forget for the same
       * reason the reset mail is: awaiting it would restore the timing
       * difference this method just removed.
       */
      void this.emailService.sendDuplicateRegistrationEmail(input.email);
      return { created: false as const, user: null };
    }

    const user = await this.userRepo.create({
      name: input.name,
      email: input.email,
      hashedPassword,
    });

    const token = crypto.randomBytes(32).toString("hex");
    await this.tokenRepo.createVerificationToken(input.email, token);
    await this.emailService.sendVerificationEmail(input.email, token);

    return { created: true as const, user };
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
   *
   * ## Why the send is not awaited
   *
   * Returning the same response for both cases only hides the answer if both
   * cases take the same TIME. Previously an unknown address returned the moment
   * the user lookup missed, while a known one additionally waited on a token
   * insert and a full HTTPS round trip to Resend — hundreds of milliseconds,
   * consistently. Timing the endpoint therefore separated registered addresses
   * from unregistered ones, defeating the exact control this method exists to
   * provide.
   *
   * Not awaiting the send removes the large and variable part of that gap. The
   * token insert remains, but it is a single indexed write on the same database
   * connection — small enough to sit inside ordinary network jitter rather than
   * standing out from it.
   *
   * The rejection handler is not optional. `void somePromise` discards the
   * value but NOT a rejection — an unhandled rejection would still surface, and
   * on some Node configurations terminate the process. `EmailService.dispatch`
   * catches internally today and returns a boolean, but this method must not
   * depend on that staying true. Following the project's fire-and-forget rule:
   * never fail the primary operation, and always log rather than swallow.
   */
  async requestPasswordReset(email: string) {
    const user = await this.userRepo.findByEmail(email);
    if (!user) return;

    const token = crypto.randomBytes(32).toString("hex");
    await this.tokenRepo.createPasswordResetToken(email, token);
    void this.emailService
      .sendPasswordResetEmail(email, token)
      .catch((error) =>
        console.error("[Password Reset] Email dispatch failed:", error)
      );
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