/**
 * User Management Service (Control Layer)
 *
 * Orchestrates user management within an organization:
 * - Listing organization members
 * - Inviting new users via email (with invitation email)
 * - Updating member roles and department assignments
 * - Assigning custom roles (blocked for company_admin)
 * - Activating/deactivating members
 *
 * BCE: Sits between Boundary (API routes) and Entity (repositories).
 * Only Company Admin can perform these operations (enforced at Boundary).
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { MembershipRepository } from "@/repositories/membership.repository";
import { InvitationRepository } from "@/repositories/invitation.repository";
import { UserRepository } from "@/repositories/user.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { RoleRepository } from "@/repositories/role.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { AccessService } from "@/services/access.service";
import { memberInScope } from "@/lib/department-scope";
import { roleRank, isFullTime } from "@/lib/role-config";
import { EmailService } from "@/services/email.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { SubscriptionService } from "@/services/subscription.service";
import { AvailabilityService } from "@/services/availability.service";
import type { InviteUserInput, UpdateUserRoleInput } from "@/lib/validations";

export class UserManagementService {
  private membershipRepo = new MembershipRepository();
  private invitationRepo = new InvitationRepository();
  private userRepo = new UserRepository();
  private orgRepo = new OrganizationRepository();
  private roleRepo = new RoleRepository();
  private deptRepo = new DepartmentRepository();
  private availabilityService = new AvailabilityService();
  private emailService = new EmailService();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();
  private accessService = new AccessService();

  /**
   * Lists an org's members, optionally limited to a department scope.
   * `departmentScope` null/undefined = unrestricted (company admin); an array
   * limits results to members belonging to those departments (a scoped
   * manager only manages staff in their own departments).
   */
  async getOrgMembers(organizationId: string, departmentScope?: string[] | null) {
    const members = await this.membershipRepo.findByOrgId(organizationId);
    if (departmentScope === undefined || departmentScope === null) {
      return members;
    }
    const scope = new Set(departmentScope);
    return members.filter((m) =>
      (m.departmentMemberships ?? []).some((dm) => scope.has(dm.department.id))
    );
  }

  /**
   * Invites a user to an organization:
   * 1. Check subscription member limit
   * 2. Check if user is already a member
   * 3. Check for existing pending invitation
   * 4. Generate secure invitation token
   * 5. Create invitation record
   * 6. Log audit event
   * 7. Send invitation email (fire-and-forget)
   */
  /**
   * Every invitation issued for an organisation, newest first — pending,
   * accepted and expired alike, because the admin screen shows the full
   * history rather than only what is outstanding.
   *
   * Org-scoped by argument: the repository filters on organizationId, so a
   * caller cannot read another tenant's invitations by any input it controls.
   */
  async getOrgInvitations(organizationId: string) {
    return this.invitationRepo.findByOrgId(organizationId);
  }

  /**
   * Refuses department ids that are not this organisation's.
   *
   * `MembershipRepository.assignDepartments` writes whatever it is handed —
   * `departmentMembership` carries a membership id and a department id and
   * nothing that ties the pair to a tenant, so an id from a request body went
   * straight into the join table. An admin of org A who was also a member of
   * org B could read B's department list through an ordinary endpoint, paste an
   * id here, and attach one of their own members to B's Kitchen. B's admin
   * could then neither see the row nor delete the department, because the
   * headcount that blocks deletion counts it.
   *
   * Counting rather than fetching: the ids are proved as a set, in one query,
   * and a short count is enough to know at least one was not ours. Naming which
   * one would confirm a foreign id exists.
   */
  private async assertDepartmentsOwned(
    departmentIds: string[],
    organizationId: string
  ) {
    if (departmentIds.length === 0) return;
    const owned = await this.deptRepo.countOwned(departmentIds, organizationId);
    if (owned !== new Set(departmentIds).size) {
      throw new Error("Department not found");
    }
  }

  async inviteUser(
    input: InviteUserInput,
    organizationId: string,
    invitedById: string
  ) {
    const inviter = await this.requireActor(organizationId, invitedById);
    this.assertMayGrantRole(roleRank(inviter.role), input.role);

    await this.subscriptionService.enforceResourceLimit(organizationId, 'members');

    // Check if the email already belongs to a member of this org
    const existingUser = await this.userRepo.findByEmail(input.email);
    if (existingUser) {
      // Including inactive: a deactivated member is still a member. The
      // (userId, organizationId) pair is unique, so inviting them again would
      // hit a constraint violation rather than create a second membership —
      // they need reactivating, not re-inviting.
      const existingMembership =
        await this.membershipRepo.findByUserAndOrgIncludingInactive(
          existingUser.id,
          organizationId
        );
      if (existingMembership) {
        throw new Error("User is already a member of this organization");
      }
    }

    // Check for duplicate pending invitation
    const pendingInvitation = await this.invitationRepo.findPendingByEmail(
      input.email,
      organizationId
    );
    if (pendingInvitation) {
      throw new Error("An invitation has already been sent to this email");
    }

    // The invitation carries this id to `assignDepartments` on accept, in a flow
    // no admin reviews again — so it is proved here, at the only point a human
    // is involved.
    if (input.departmentId) {
      await this.assertDepartmentsOwned([input.departmentId], organizationId);
    }

    // Generate secure token and create invitation
    const token = crypto.randomBytes(32).toString("hex");

    const invitation = await this.invitationRepo.create({
      organizationId,
      email: input.email,
      role: input.role,
      departmentId: input.departmentId,
      employmentType: input.employmentType,
      token,
      invitedById,
    });

    await this.auditService.log({
      organizationId,
      userId: invitedById,
      action: ACTIONS.MEMBER_INVITED,
      entityType: "invitation",
      entityId: invitation.id,
      details: { email: input.email, role: input.role },
    });

    // Send invitation email (fire-and-forget — never blocks or fails the invite)
    this.sendInvitationEmailAsync(
      input.email,
      token,
      organizationId,
      invitedById
    );

    return invitation;
  }

  /**
   * Sends the invitation email asynchronously.
   * Fetches org name and inviter name, then delegates to EmailService.
   * Errors are logged but never propagated — the invitation is
   * already created regardless of email delivery.
   */
  private async sendInvitationEmailAsync(
    email: string,
    token: string,
    organizationId: string,
    invitedById: string
  ) {
    try {
      const [org, inviter] = await Promise.all([
        this.orgRepo.findById(organizationId),
        this.userRepo.findById(invitedById),
      ]);

      await this.emailService.sendInvitationEmail(
        email,
        token,
        org?.name || "your organization",
        inviter?.name || inviter?.email || "A team member"
      );
    } catch (error) {
      console.error("[Invite Email Error]", error);
    }
  }

  /**
   * Updates a member's role and optionally their department assignments.
   * Prevents the last company_admin from being demoted.
   * Auto-clears custom role when promoting to company_admin
   * (admins have full access — custom roles are redundant).
   */
  /**
   * Refuses a role change that would reach above the person making it.
   *
   * ## Why this exists
   *
   * `members:update_role` used to be reachable only by a company_admin, so
   * these checks would have been dead code — an admin promoting themselves
   * changes nothing. Once permissions became enforceable, an org admin could
   * grant that permission to a custom role, and the picker describes it as
   * "Update member roles". An admin reading that reasonably expects "this
   * person can move staff between Staff and Manager".
   *
   * What it actually allowed was one request:
   *
   *     PATCH /organizations/{org}/members/{their own id}  { role: "company_admin" }
   *
   * `userId` comes from the URL and was never compared against the caller, and
   * `company_admin` was an accepted value. The holder made themselves the owner
   * of the organisation — billing, audit log, and the roles system itself.
   *
   * ## The rule
   *
   * Nobody may change their own role, and nobody may reach above their own
   * level in either direction. The third clause matters as much as the first
   * two: without it a manager could not promote anyone to admin, but could
   * DEMOTE one, which is the same authority pointed the other way.
   *
   * Enforced here rather than in the route so that every caller is covered —
   * the escalation was possible precisely because a check lived somewhere a new
   * code path did not have to pass through.
   */
  private async assertMayChangeRole(
    organizationId: string,
    target: { id: string; role: string },
    newRole: string,
    performedById?: string
  ) {
    // No identified actor means an internal call with no session behind it —
    // there is no "own role" to protect and no privilege to exceed, so there is
    // nothing to compare. Every route-reachable caller passes one.
    if (!performedById) return;

    const actor = await this.requireActor(organizationId, performedById);

    /*
     * You cannot change your OWN ROLE — but everything else about yourself is
     * fine, and this refused all of it.
     *
     * The member drawer sends the whole shape on every edit, so assigning
     * yourself to a department or setting your own employment type arrives here
     * carrying `role` unchanged. This threw on the id comparison alone, so an
     * admin could not put themselves in a department at all: they got a red
     * "You cannot change your own role" for an action that changed no role.
     *
     * The guard exists to stop somebody promoting themselves or removing their
     * own admin rights and locking the organisation out of its own settings.
     * Neither is possible when the role is the one they already hold, so the
     * comparison is what the rule was always about.
     */
    if (actor.id === target.id && newRole !== target.role) {
      throw new Error("You cannot change your own role");
    }

    const actorRank = roleRank(actor.role);
    if (roleRank(newRole) > actorRank) {
      throw new Error("You cannot grant a role above your own");
    }
    if (roleRank(target.role) > actorRank) {
      throw new Error("You cannot change the role of a member above your own");
    }
  }

  /**
   * The acting member, or a refusal.
   *
   * Every authority comparison in this service starts here. An actor with no
   * active membership should never have passed the route gate, so reaching
   * this with nothing found means something is wrong upstream — refusing is
   * the only safe reading.
   */
  private async requireActor(organizationId: string, performedById: string) {
    const actor = await this.membershipRepo.findByUserAndOrg(
      performedById,
      organizationId
    );
    if (!actor) throw new Error("Not authorized to change roles");
    return actor;
  }

  /**
   * Refuses CREATING a membership at a role above the creator's own.
   *
   * `assertMayChangeRole` guards the edit path and was, for a while, the only
   * guard — which left the two paths that mint a membership rather than amend
   * one wide open. Both are reachable with `members:invite` alone:
   *
   *     POST /organizations/{org}/invitations   { email, role: "manager" }
   *     POST /organizations/{org}/members/import  [{ …, role: "manager" }]
   *
   * A staff member holding a "Recruiter" custom role could invite an address
   * they control as a manager, accept it, and arrive at an authority their own
   * account was never granted — the same escalation as the role picker, one
   * door along. The rule is the edit path's second clause: you cannot hand out
   * what you do not hold.
   *
   * Takes the resolved actor rather than an id so the batch importer can look
   * it up once for a hundred rows instead of once per row.
   */
  private assertMayGrantRole(actorRank: number, newRole: string) {
    if (roleRank(newRole) > actorRank) {
      throw new Error("You cannot grant a role above your own");
    }
  }

  async updateMemberRole(
    userId: string,
    organizationId: string,
    input: UpdateUserRoleInput,
    performedById?: string,
    /**
     * The caller's departments, or null for a company admin.
     *
     * `members:update_role` is admin-only by default, which is why this was
     * missing — but an admin can put it in a custom role, and then a Kitchen
     * manager could strip a Front-of-House member of their departments and make
     * them silently unrosterable. The three sibling endpoints on the same
     * member (`/seniority`, `/contracted-days`, `/request-availability`) all
     * apply it; this one and `/toggle-status` did not.
     */
    departmentScope?: string[] | null
  ) {
    // Including inactive: `userId` is the member being administered, not the
    // admin doing it. An inactive member's role must still be changeable.
    const membership =
      await this.membershipRepo.findByUserAndOrgIncludingInactive(
        userId,
        organizationId
      );
    if (!membership) {
      throw new Error("Membership not found");
    }
    if (!memberInScope(membership, departmentScope)) {
      throw new Error("Membership not found");
    }

    const previousRole = membership.role;

    await this.assertMayChangeRole(
      organizationId,
      membership,
      input.role,
      performedById
    );

    /*
     * Validated here, though it is written by `assignCustomRole` afterwards.
     *
     * The route applies the two halves in sequence, and this half used to be
     * checked only once the first had already committed. A request naming a
     * custom role from another organisation returned 404 — after the system
     * role, employment type and departments had been written and audit-logged.
     * The screen said it failed; the database said the member was promoted.
     *
     * Checking up front costs one lookup and makes the pair behave as one
     * decision: either every refusal lands before any write, or none of them
     * do.
     */
    if (input.customRoleId) {
      await this.assertCustomRoleAssignable(
        organizationId,
        input.customRoleId,
        input.role,
        performedById
      );
    }

    // Prevent demoting the last company_admin
    if (membership.role === "company_admin" && input.role !== "company_admin") {
      const allMembers = await this.membershipRepo.findByOrgId(organizationId);
      const adminCount = allMembers.filter(
        (m) => m.role === "company_admin" && m.status === "active"
      ).length;

      if (adminCount <= 1) {
        throw new Error(
          "Cannot demote the last Company Admin. Promote another member first."
        );
      }
    }

    // Update the role
    const updated = await this.membershipRepo.updateRole(
      membership.id,
      input.role
    );

    // Auto-clear custom role when promoting to company_admin
    if (input.role === "company_admin") {
      const currentCustomRoleId = (membership as Record<string, unknown>).customRoleId as string | null;
      if (currentCustomRoleId) {
        await this.membershipRepo.updateCustomRole(membership.id, null);
      }
    }

    // Update employment type if provided
    if (input.employmentType !== undefined) {
      await this.membershipRepo.updateEmploymentType(
        membership.id,
        input.employmentType
      );

      /*
       * Becoming contracted also closes the door on setting your own days, so
       * anything left unsaid would stay unsaid forever — and an unset day reads
       * as unavailable. A casual converted mid-week would otherwise lose every
       * day they had never got round to filling in, with no way to get it back
       * themselves.
       *
       * Only the gaps. What they already told us about their week survives the
       * change of employment type.
       */
      if (isFullTime(input.employmentType)) {
        await this.availabilityService.openUnsetDays(membership.id);
      }
    }

    // Update department assignments if provided
    if (input.departmentIds) {
      await this.assertDepartmentsOwned(input.departmentIds, organizationId);
      await this.membershipRepo.assignDepartments(
        membership.id,
        input.departmentIds
      );
    }

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: ACTIONS.MEMBER_ROLE_CHANGED,
      entityType: "member",
      entityId: userId,
      details: { previousRole, newRole: input.role, departmentIds: input.departmentIds, employmentType: input.employmentType },
    });

    return updated;
  }

  /**
   * Refuses a custom role that must not be assigned, before anything is written.
   *
   * Three separate refusals, all of them about the role rather than the member:
   * it must belong to this organisation, it must not be one of the system
   * roles masquerading as a custom one, and — the one added last — it must not
   * carry a permission the person assigning it does not hold.
   *
   * That last rule is the second escalation door. Blocking self-assignment
   * closes the direct route; this closes the one that goes through somebody
   * else. A manager holding only `members:update_role` could otherwise pick
   * any staff member, give them a role carrying `billing:manage`,
   * `roles:manage` and `audit:view`, and have every one of those exercised on
   * request — authority delegated by proxy, by someone who never had it.
   *
   * A subset test rather than an admin-only rule, because delegating a
   * NARROWER role is exactly what the permission is for. A company admin holds
   * the whole catalogue, so this never constrains one.
   *
   * `effectiveRole` is the role the member will hold once the request
   * finishes, not necessarily the one they hold now — a request that promotes
   * someone to admin and assigns a custom role in the same breath has to be
   * judged on where it lands.
   */
  private async assertCustomRoleAssignable(
    organizationId: string,
    customRoleId: string | null,
    effectiveRole: string,
    performedById?: string,
    resolvedActor?: Awaited<ReturnType<typeof this.requireActor>> | null
  ) {
    if (effectiveRole === "company_admin" && customRoleId !== null) {
      throw new Error("Company Admins cannot be assigned custom roles");
    }
    if (!customRoleId) return;

    const role = await this.roleRepo.findById(customRoleId);
    if (!role || role.organizationId !== organizationId) {
      throw new Error("Custom role not found");
    }
    if (role.isSystemRole) {
      throw new Error("Cannot assign system roles as custom roles");
    }

    if (!performedById) return;
    const actor =
      resolvedActor ?? (await this.requireActor(organizationId, performedById));

    const held = this.accessService.permissionsFor(actor);
    const excess = role.rolePermissions
      .map((rp) => rp.permission.name)
      .filter((name) => !held.has(name));
    if (excess.length > 0) {
      throw new Error(
        `You cannot grant permissions you do not hold: ${excess.join(", ")}`
      );
    }
  }

  /**
   * Assigns a custom role to a member.
   * Company admins cannot have custom roles (they have full access).
   * Pass null to clear the custom role.
   */
  async assignCustomRole(
    userId: string,
    organizationId: string,
    customRoleId: string | null,
    performedById?: string
  ) {
    // Including inactive: administering the target member, not authorising the
    // caller.
    const membership =
      await this.membershipRepo.findByUserAndOrgIncludingInactive(
        userId,
        organizationId
      );
    if (!membership) {
      throw new Error("Membership not found");
    }

    /*
     * The same escalation by a different door.
     *
     * Guarding only the SYSTEM role would leave this open: a holder of
     * `members:update_role` who cannot promote themselves could instead give
     * themselves an existing custom role carrying every permission, which is
     * the same authority without the title. Both routes into this service run
     * off one permission, so both need the same rule.
     *
     * Assigning a custom role to someone ELSE stays allowed — that is the
     * delegation the permission is for.
     */
    let actor: Awaited<ReturnType<typeof this.requireActor>> | null = null;
    if (performedById) {
      actor = await this.requireActor(organizationId, performedById);
      if (actor.id === membership.id) {
        throw new Error("You cannot change your own role");
      }
      if (roleRank(membership.role) > roleRank(actor.role)) {
        throw new Error("You cannot change the role of a member above your own");
      }
    }

    // Validate custom role exists in the org if assigning (not clearing)
    await this.assertCustomRoleAssignable(
      organizationId,
      customRoleId,
      membership.role,
      performedById,
      actor
    );

    /*
     * Read BEFORE the write, and by name.
     *
     * This recorded `{ customRoleId }` — a bare cuid — under the same action as
     * a system-role change. Deleting a custom role is allowed and strips its
     * holders, so once the role was gone the entry pointed at nothing and
     * nobody could tell what the member had been granted. The label is captured
     * here, while the role still exists, for the same reason the role-delete
     * entry counts its holders before deleting them.
     *
     * The PREVIOUS role is recorded too. "Assigned Shift Lead" and "moved from
     * Rota Manager to Shift Lead" are different facts, and only the second one
     * answers what somebody lost.
     */
    const previousRoleId = membership.customRoleId ?? null;
    const [assignedRole, previousRole] = await Promise.all([
      customRoleId ? this.roleRepo.findById(customRoleId) : Promise.resolve(null),
      previousRoleId ? this.roleRepo.findById(previousRoleId) : Promise.resolve(null),
    ]);

    await this.membershipRepo.updateCustomRole(membership.id, customRoleId);

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: customRoleId
        ? ACTIONS.MEMBER_CUSTOM_ROLE_ASSIGNED
        : ACTIONS.MEMBER_CUSTOM_ROLE_CLEARED,
      entityType: "member",
      entityId: userId,
      details: {
        customRoleId,
        roleLabel: assignedRole?.displayLabel ?? null,
        previousRoleId,
        previousRoleLabel: previousRole?.displayLabel ?? null,
      },
    });

    return { ...membership, customRoleId };
  }

  /**
   * Toggles a member's status between active and inactive.
   * Deactivation prevents access to the organization.
   */
  async toggleMemberStatus(
    userId: string,
    organizationId: string,
    performedById?: string,
    /** See `updateMemberRole` — a peer manager could otherwise lock out a
     * manager in a department they have nothing to do with. */
    departmentScope?: string[] | null
  ) {
    // Including inactive is REQUIRED here, not merely preferable: reactivating a
    // member means looking them up while they are inactive. An active-only
    // lookup would throw "Membership not found" and make deactivation
    // irreversible.
    const membership =
      await this.membershipRepo.findByUserAndOrgIncludingInactive(
        userId,
        organizationId
      );
    if (!membership) {
      throw new Error("Membership not found");
    }
    if (!memberInScope(membership, departmentScope)) {
      throw new Error("Membership not found");
    }

    /*
     * Deactivation is a role change with no role picker.
     *
     * `findByUserAndOrg` filters on `status: "active"`, so an inactive
     * membership resolves to nothing and every guard in the product refuses
     * the person — which makes `members:deactivate` an authority switch, not
     * an administrative convenience. Without a rank check a staff member
     * holding that one permission could deactivate every company admin and
     * every manager in turn and lock the organisation out of itself.
     *
     * The self-check is not vanity: an admin deactivating themselves while
     * other admins remain passes the last-admin guard below and leaves them
     * unable to undo it.
     */
    if (performedById) {
      const actor = await this.requireActor(organizationId, performedById);
      if (actor.id === membership.id) {
        throw new Error("You cannot change your own status");
      }
      if (roleRank(membership.role) > roleRank(actor.role)) {
        throw new Error(
          "You cannot change the status of a member above your own"
        );
      }
    }

    // Prevent deactivating the last active admin
    if (membership.role === "company_admin" && membership.status === "active") {
      const allMembers = await this.membershipRepo.findByOrgId(organizationId);
      const activeAdmins = allMembers.filter(
        (m) => m.role === "company_admin" && m.status === "active"
      );

      if (activeAdmins.length <= 1) {
        throw new Error(
          "Cannot deactivate the last active Company Admin."
        );
      }
    }

    const newStatus = membership.status === "active" ? "inactive" : "active";

    /*
     * Reactivating takes a seat, so it has to be checked like taking one.
     *
     * The member limit counts ACTIVE memberships, and deactivating is the
     * product's way of freeing a seat under a cap. Nothing stopped that seat
     * being given away and then claimed a second time: deactivate somebody at
     * the limit, invite a replacement into the gap, reactivate the original,
     * and the organisation is one over with every individual step allowed.
     *
     * Only on the way IN. Deactivating is always permitted — refusing it would
     * mean an organisation that has gone over its cap by any route could not
     * get back under it.
     */
    if (newStatus === "active") {
      await this.subscriptionService.enforceResourceLimit(
        organizationId,
        "members"
      );
    }

    const updated = await this.membershipRepo.updateStatus(membership.id, newStatus);

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: newStatus === "active" ? ACTIONS.MEMBER_ACTIVATED : ACTIONS.MEMBER_DEACTIVATED,
      entityType: "member",
      entityId: userId,
      details: { previousStatus: membership.status, newStatus },
    });

    return updated;
  }

  /**
   * Batch imports members from a spreadsheet upload.
   * For each row:
   * 1. Find or create user (new users get a random password — they use "Forgot Password" to set their own)
   * 2. Create membership with role and employment type
   * 3. Assign department by name lookup
   * 4. Audit log each creation
   *
   * Partial-success pattern — one failed row does not stop the batch.
   * Returns created count, failed count, and per-row error messages.
   */
  async batchImportMembers(
    organizationId: string,
    members: {
      name: string;
      email: string;
      role: string;
      departmentName: string | null;
      employmentType: string;
    }[],
    performedById: string
  ): Promise<{ created: number; failed: number; errors: string[] }> {
    // Resolved once for the whole batch — the rank is the same for every row,
    // and a hundred rows should not mean a hundred authorisation lookups.
    const importerRank = roleRank(
      (await this.requireActor(organizationId, performedById)).role
    );

    // Pre-fetch org departments for name → ID lookup
    const departments = await this.deptRepo.findByOrganizationId(organizationId);
    const deptMap = new Map(
      departments.map((d) => [d.name.toLowerCase(), d.id])
    );

    // Pre-fetch existing members to detect duplicates
    const existingMembers = await this.membershipRepo.findByOrgId(organizationId);
    const existingEmails = new Set(
      existingMembers.map((m) => m.user.email.toLowerCase())
    );

    // Track emails within batch to detect intra-batch duplicates
    const seenEmails = new Set<string>();

    let created = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const member of members) {
      const email = member.email.toLowerCase().trim();

      try {
        // Check intra-batch duplicate
        if (seenEmails.has(email)) {
          errors.push(`Row ${email}: Duplicate email within import`);
          failed++;
          continue;
        }
        seenEmails.add(email);

        // Check existing membership
        if (existingEmails.has(email)) {
          errors.push(`Row ${email}: Already a member`);
          failed++;
          continue;
        }

        // Refused per row rather than for the whole file: a spreadsheet with
        // one row typed above the importer's authority should not discard the
        // ninety-nine that were fine, and the error names the row so it can be
        // corrected and re-uploaded.
        if (roleRank(member.role) > importerRank) {
          errors.push(
            `Row ${email}: Cannot import a member at a role above your own`
          );
          failed++;
          continue;
        }

        // Resolve department
        let departmentId: string | null = null;
        if (member.departmentName) {
          departmentId = deptMap.get(member.departmentName.toLowerCase()) || null;
          if (!departmentId) {
            errors.push(
              `Row ${email}: Department "${member.departmentName}" not found`
            );
            failed++;
            continue;
          }
        }

        // Find or create user
        let user = await this.userRepo.findByEmail(email);
        if (!user) {
          const randomPassword = crypto.randomBytes(32).toString("hex");
          const hashedPassword = await bcrypt.hash(randomPassword, 12);
          user = await this.userRepo.create({
            name: member.name.trim(),
            email,
            hashedPassword,
          });
          // Mark email as verified — admin is adding them directly
          await this.userRepo.verifyEmail(user.id);
        }

        // Create membership
        const membership = await this.membershipRepo.create({
          userId: user.id,
          organizationId,
          role: member.role,
          employmentType: member.employmentType,
        });

        // Assign department
        if (departmentId) {
          await this.membershipRepo.assignDepartments(membership.id, [departmentId]);
        }

        // Audit log (fire-and-forget)
        void this.auditService.log({
          organizationId,
          userId: performedById,
          action: ACTIONS.MEMBER_INVITED,
          entityType: "member",
          entityId: user.id,
          details: {
            method: "batch_import",
            email,
            role: member.role,
            employmentType: member.employmentType,
            departmentName: member.departmentName,
          },
        });

        created++;
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(`Row ${email}: ${msg}`);
        failed++;
      }
    }

    return { created, failed, errors };
  }
}