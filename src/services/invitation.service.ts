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
import { AvailabilityService } from "@/services/availability.service";
import { isFullTime } from "@/lib/role-config";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { SubscriptionService } from "@/services/subscription.service";

export class InvitationService {
  private invitationRepo = new InvitationRepository();
  private auditService = new AuditLogService();
  private membershipRepo = new MembershipRepository();
  private userRepo = new UserRepository();
  private availabilityService = new AvailabilityService();
  private subscriptionService = new SubscriptionService();

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
    const invitationEmploymentType = invitation.employmentType;

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

    /*
     * The seat has to still exist at the moment it is taken.
     *
     * `inviteUser` enforces the member limit when the invitation goes OUT, and
     * that was the only check — but an invitation is not a membership, so the
     * count it is measured against does not move while invitations are
     * outstanding. An organisation one short of its limit could send five
     * invitations, each allowed against the same unchanged count, and end up
     * five members over the cap with nothing having refused a single step.
     *
     * The general shape, which this codebase has met before: the limit counts a
     * STATE, the guard sat on one path INTO that state, and the other paths
     * walked past it. Ask which paths reach the state, not which path the guard
     * was written for.
     *
     * Checked here, immediately before the write, rather than earlier in the
     * method — the org can fill up between a user being created and this line,
     * and the check is worth nothing if it is not adjacent to the thing it
     * guards.
     *
     * The invitation is deliberately NOT marked accepted: this is the
     * organisation's problem, not the invitee's, and the invitation should
     * still work once an admin upgrades or frees a seat.
     */
    await this.subscriptionService.enforceResourceLimit(
      invitation.organizationId,
      "members"
    );

    const membership = await this.membershipRepo.create({
      userId: user!.id,
      organizationId: invitation.organizationId,
      role: invitation.role,
      employmentType: invitationEmploymentType ?? undefined,
    });

    /*
     * Somebody joining the organisation.
     *
     * `member.invited` was already logged when the invitation went out, so the
     * log recorded the offer and not the acceptance — leaving no answer to
     * "when did this person actually get access", which is the question that
     * matters after the fact. The invitation may also have sat unaccepted for
     * weeks, so the two events are not interchangeable.
     */
    void this.auditService.log({
      organizationId: invitation.organizationId,
      userId: user!.id,
      action: ACTIONS.MEMBER_JOINED,
      entityType: "member",
      entityId: membership.id,
      details: { role: invitation.role, email: invitation.email },
    });

    /*
     * A contracted member cannot set their own days, and a day nobody has set
     * counts as unavailable — so without this a new full-timer joins the
     * organisation unrostearable on every day of the week. Opened here rather
     * than left to the admin because "the engine found no candidates" is a very
     * expensive way to discover a member was never given a pattern.
     */
    if (isFullTime(invitationEmploymentType)) {
      await this.availabilityService.openUnsetDays(membership.id);
    }

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