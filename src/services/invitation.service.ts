/**
 * Invitation Service (Control Layer)
 * 
 * Handles the invitation acceptance flow:
 * - New users: creates account (with verified email) + org membership
 * - Existing users: creates org membership only
 * - Assigns department if specified in the invitation
 * 
 * Invited users get their email auto-verified since the invitation
 * was sent to their email by a trusted Company Admin.
 * 
 * Security:
 * - Tokens validated for existence, expiry, and acceptance status
 * - Passwords hashed with bcrypt before storage
 */
import bcrypt from "bcryptjs";
import { InvitationRepository } from "@/repositories/invitation.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { UserRepository } from "@/repositories/user.repository";

export class InvitationService {
  private invitationRepo = new InvitationRepository();
  private membershipRepo = new MembershipRepository();
  private userRepo = new UserRepository();

  /**
   * Retrieves invitation details for the acceptance page.
   * Returns null if token is invalid, expired, or already accepted.
   */
  async getInvitationDetails(token: string) {
    const invitation = await this.invitationRepo.findByToken(token);

    if (!invitation) return null;
    if (invitation.acceptedAt) return null;
    if (invitation.expires < new Date()) return null;

    return invitation;
  }

  /**
   * Accepts an invitation and creates the user's org membership.
   * 
   * @param token - The invitation token from the URL
   * @param registrationData - Name and password for new users, null for existing users
   * 
   * Flow for new users:
   * 1. Validate invitation token
   * 2. Create user account with hashed password and verified email
   * 3. Create org membership with invited role
   * 4. Assign department if specified
   * 5. Mark invitation as accepted
   * 
   * Flow for existing users:
   * 1. Validate invitation token
   * 2. Find existing user by email
   * 3. Create org membership with invited role
   * 4. Assign department if specified
   * 5. Mark invitation as accepted
   */
  async acceptInvitation(
    token: string,
    registrationData: { name: string; password: string } | null
  ) {
    // Validate the invitation
    const invitation = await this.invitationRepo.findByToken(token);

    if (!invitation || invitation.acceptedAt || invitation.expires < new Date()) {
      throw new Error("Invalid or expired invitation");
    }

    // Find or create the user
    let user = await this.userRepo.findByEmail(invitation.email);

    if (!user && registrationData) {
      // New user — create account with verified email
      const hashedPassword = await bcrypt.hash(registrationData.password, 12);
      user = await this.userRepo.create({
        name: registrationData.name,
        email: invitation.email,
        hashedPassword,
      });
      // Auto-verify email since invitation came from a trusted admin
      user = await this.userRepo.verifyEmail(user.id);
    } else if (!user && !registrationData) {
      throw new Error("Registration data required for new users");
    }

    // Create org membership (carry employmentType from invitation if set)
    // TODO: Remove cast after running `npx prisma generate` — employmentType
    // was added in migration 20260726000000; Prisma types will include it.
    const invitationEmploymentType = (invitation as typeof invitation & { employmentType?: string | null }).employmentType;

    // Already a member? Say so, rather than letting Prisma raise a raw P2002 on
    // the (userId, organizationId) unique constraint — that surfaced as an
    // unmapped 500. Two ordinary situations reach here: a double-click on
    // Accept, and an admin adding the person manually between the invite being
    // sent and it being opened. Neither is a server fault.
    //
    // The invitation is consumed either way. Leaving it open would let a stale
    // link keep failing forever, and the person IS in the organisation, which
    // is the outcome the invitation was for.
    const existing = await this.membershipRepo.findByUserAndOrgIncludingInactive(
      user!.id,
      invitation.organizationId
    );
    if (existing) {
      await this.invitationRepo.markAccepted(invitation.id);
      throw new Error("You are already a member of this organization");
    }

    const membership = await this.membershipRepo.create({
      userId: user!.id,
      organizationId: invitation.organizationId,
      role: invitation.role,
      employmentType: invitationEmploymentType ?? undefined,
    });

    // Assign department if specified in the invitation
    if (invitation.departmentId) {
      await this.membershipRepo.assignDepartments(membership.id, [
        invitation.departmentId,
      ]);
    }

    // Mark invitation as accepted
    await this.invitationRepo.markAccepted(invitation.id);

    return { user: user! };
  }
}