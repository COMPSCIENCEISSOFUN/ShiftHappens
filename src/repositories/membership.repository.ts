/**
 * Membership Repository (Entity Layer)
 * 
 * Data access layer for organization membership operations.
 * Handles member listing, role updates, status changes (activate/deactivate),
 * and department assignments.
 * 
 * Multi-tenancy: All queries are org-scoped for tenant isolation.
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";

export class MembershipRepository {
  /**
   * Lists all members of an organization with their user details
   * and department assignments. Used by Company Admin and Manager
   * for user management views.
   */
  async findByOrgId(organizationId: string) {
    return prisma.membership.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
          },
        },
        departmentMemberships: {
          include: {
            department: {
              select: { id: true, name: true },
            },
          },
        },
        customRole: {
          select: { id: true, name: true, displayLabel: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Finds a user's ACTIVE membership in an organization.
   *
   * This answers the authorisation question — "may this person act here?" — and
   * it is deliberately the default, because that is what every API route is
   * asking when it calls this. Previously the status was not filtered, so a
   * deactivated member satisfied every `if (!membership)` gate in the
   * application and kept full access to an organisation they had been removed
   * from. Only three route files checked `membership.status` themselves.
   *
   * Administering a member who is NOT active — reactivating them, changing their
   * role, checking whether an invitee already exists — must use
   * `findByUserAndOrgIncludingInactive` and say so explicitly.
   *
   * Making the strict behaviour the default is the point: a newly written route
   * is safe unless someone deliberately opts out, so the failure mode is a
   * visible 403 rather than a silent privilege leak.
   *
   * `findFirst`, not `findUnique`: the composite unique key is
   * (userId, organizationId) and does not include status, so `findUnique`
   * cannot express this filter.
   */
  async findByUserAndOrg(userId: string, organizationId: string) {
    return prisma.membership.findFirst({
      where: {
        userId,
        organizationId,
        status: "active",
      },
      include: {
        departmentMemberships: {
          include: {
            department: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });
  }

  /**
   * Finds a user's membership regardless of status.
   *
   * For ADMINISTERING a member rather than authorising one. `UserManagementService`
   * needs this in four places — re-invite detection, role change, custom-role
   * assignment and the activate/deactivate toggle — because all four operate on a
   * member who may currently be inactive. Filtering them out would make a
   * deactivated member permanently unrecoverable: reactivation looks the member
   * up before flipping the status, so it would fail with "Membership not found".
   *
   * Do NOT use this for permission checks. If you are deciding whether the
   * CALLER may do something, you want `findByUserAndOrg`.
   */
  async findByUserAndOrgIncludingInactive(
    userId: string,
    organizationId: string
  ) {
    return prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
      include: {
        departmentMemberships: {
          include: {
            department: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });
  }

  /** Creates a new membership (used when inviting users to an org) */
  async create(data: {
    userId: string;
    organizationId: string;
    role: string;
    employmentType?: string;
  }) {
    return prisma.membership.create({
      data: {
        userId: data.userId,
        organizationId: data.organizationId,
        role: data.role,
        status: "active",
        employmentType: data.employmentType || null,
      },
    });
  }

  /** Updates a member's role (e.g. staff → manager) */
  async updateRole(membershipId: string, role: string) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { role },
    });
  }

  /** Sets or clears a member's custom role assignment */
  async updateCustomRole(membershipId: string, customRoleId: string | null) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { customRoleId },
    });
  }

  /**
   * Pins a member's seniority, or clears the pin so it derives again.
   *
   * `null` is a real instruction here, not an absent argument — it means "stop
   * overriding and go back to counting completed shifts". Prisma ignores
   * `undefined`, so a caller passing that would silently leave the old pin in
   * place and report success.
   */
  async updateSeniorityOverride(membershipId: string, level: string | null) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { seniorityOverride: level },
    });
  }

  /**
   * Names and employment types for a set of memberships.
   *
   * Falls back to the email when a user has no name — the same rule the
   * reporting queries use, so a person appears under one label everywhere
   * rather than as "Unknown" in one panel and their email in another.
   */
  async findManyWithNames(
    ids: string[]
  ): Promise<{ id: string; name: string; employmentType: string | null }[]> {
    if (ids.length === 0) return [];

    const rows = await prisma.membership.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        employmentType: true,
        user: { select: { name: true, email: true } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      name: r.user.name ?? r.user.email,
      employmentType: r.employmentType,
    }));
  }

  /**
   * Seniority pins for a set of memberships, keyed by id.
   *
   * The eligibility and composition paths need this for every candidate at
   * once and nothing else about them, so it stays a narrow select rather than
   * reusing `findByOrgId` and discarding the users, departments and roles.
   */
  async getSeniorityOverrides(
    membershipIds: string[]
  ): Promise<Record<string, string | null>> {
    if (membershipIds.length === 0) return {};

    const rows = await prisma.membership.findMany({
      where: { id: { in: membershipIds } },
      select: { id: true, seniorityOverride: true },
    });

    const map: Record<string, string | null> = {};
    for (const row of rows) map[row.id] = row.seniorityOverride;
    return map;
  }

  /** Updates a member's employment type (full_time / casual) */
  async updateEmploymentType(membershipId: string, employmentType: string) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { employmentType },
    });
  }

  /**
   * Updates a member's status (active/inactive).
   * Deactivation prevents login to this org.
   * Task auto-unassignment will be added in Phase 4.
   */
  async updateStatus(membershipId: string, status: string) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { status },
    });
  }

  /**
   * Assigns a member to one or more departments.
   * Uses delete-then-create pattern to replace existing assignments.
   * This supports managers with multiple department assignments.
   */
  async assignDepartments(membershipId: string, departmentIds: string[]) {
    // Remove all current department assignments
    await prisma.departmentMembership.deleteMany({
      where: { membershipId },
    });

    // Create new assignments
    if (departmentIds.length > 0) {
      await prisma.departmentMembership.createMany({
        data: departmentIds.map((departmentId) => ({
          membershipId,
          departmentId,
        })),
      });
    }
  }

  /** Gets all departments a member is assigned to */
  async getDepartments(membershipId: string) {
    return prisma.departmentMembership.findMany({
      where: { membershipId },
      include: {
        department: {
          select: { id: true, name: true },
        },
      },
    });
  }

  /** Finds a membership by its ID */
  /**
   * Returns the subset of the given membership ids that belong to this
   * organisation. Counterpart to TaskRepository.findManyByIdsInOrg — see there.
   */
  async findManyByIdsInOrg(ids: string[], organizationId: string) {
    if (ids.length === 0) return [];
    return prisma.membership.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true },
    });
  }

  async findById(id: string) {
    return prisma.membership.findUnique({
      where: { id },
    });
  }

  /**
   * Finds a membership with the user and department details needed for
   * eligibility checks and hour-limit alerting.
   */
  async findByIdWithDetails(id: string) {
    return prisma.membership.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        departmentMemberships: {
          include: { department: { select: { id: true, name: true } } },
        },
      },
    });
  }

  /**
   * The members an automatic schedule may draw on: active staff and managers,
   * with the user and department details the generator needs to match people
   * to work. Company admins are excluded — they administer the roster rather
   * than appear on it, and auto-filling their week would book the person who
   * is supposed to be reviewing the draft.
   */
  async findSchedulableStaff(organizationId: string) {
    return prisma.membership.findMany({
      where: {
        organizationId,
        status: "active",
        role: { in: ["staff", "manager"] },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        departmentMemberships: {
          include: { department: { select: { id: true, name: true } } },
        },
      },
    });
  }
}