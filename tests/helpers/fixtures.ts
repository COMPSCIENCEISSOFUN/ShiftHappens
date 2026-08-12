/**
 * Shared test fixtures.
 *
 * Promoted out of `tests/services/tenant-isolation.test.ts`, which had the right
 * shape but kept it file-local. Route tests need more than that file did: a
 * member at each role, a department-scoped manager, and — the reason this exists
 * at all — a member whose membership is INACTIVE, so the authorisation contract
 * can be asserted rather than assumed.
 *
 * Emails and slugs carry a counter suffix. The suite runs with
 * `fileParallelism: false` and truncates between tests, so collisions are not
 * possible today; the suffix means they stay impossible if anyone ever turns
 * parallelism on to speed up a growing suite.
 */
import { prisma } from "@/lib/prisma";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";

const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let counter = 0;

/** Resets the uniqueness counter. Call from a global beforeEach if desired. */
export function resetFixtureCounter() {
  counter = 0;
}

export interface TenantMember {
  userId: string;
  membershipId: string;
  email: string;
}

export interface Tenant {
  orgId: string;
  orgSlug: string;
  departmentId: string;
  /** company_admin, active */
  admin: TenantMember;
  /** manager, active, assigned to `departmentId` */
  manager: TenantMember;
  /** staff, active, assigned to `departmentId` */
  staff: TenantMember;
  /** staff, membership status "inactive" — was a member, has been deactivated */
  inactive: TenantMember;
  /** A real user with NO membership in this organisation */
  outsider: { userId: string; email: string };
}

async function makeUser(label: string, slug: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${slug}-${counter++}@example.com`;
  const user = await userRepo.create({
    name: `${label} ${slug}`,
    email,
    hashedPassword: "hash",
  });
  return { id: user.id, email };
}

/**
 * Builds a complete organisation: admin, manager, staff, a deactivated member,
 * an unrelated outsider, one department, and company settings.
 *
 * `subscriptionTier` defaults to "enterprise" so feature gates (audit log, PDF
 * export, custom roles) do not mask an authorisation result with a 403 for a
 * completely different reason.
 */
export async function createTenant(
  label = "t",
  options: { subscriptionTier?: string; orgStatus?: string } = {}
): Promise<Tenant> {
  const slug = `${label}-${counter++}`;

  const adminUser = await makeUser("admin", slug);
  const org = await orgRepo.create({ name: `Org ${slug}`, slug }, adminUser.id);

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      subscriptionTier: options.subscriptionTier ?? "enterprise",
      ...(options.orgStatus ? { status: options.orgStatus } : {}),
    },
  });

  await prisma.companySettings.create({
    data: {
      organizationId: org.id,
      /*
       * Stated, not inherited from the column default.
       *
       * That default became "auto" on 2026-08-13 so new organisations get the
       * automation they signed up for — which would have silently put every
       * test tenant into automatic assignment, so any test creating a task
       * would fire the allocation engine and half the suite would be exercising
       * a path it never meant to.
       *
       * Pinning it here is the right shape regardless: a fixture whose
       * behaviour turns on a column default is one nobody can read.
       */
      allocationMode: "suggested",
      /*
       * `taskAcceptanceMode: "require_acceptance"` stood here until the setting
       * was removed on 2026-08-13, and it is worth knowing what it was doing:
       * every assignment a test made was written `pending`, because the tenant
       * asked for staff to accept first.
       *
       * Assignments now land `accepted`, which is what the product does. A test
       * that needs one waiting on a member has to create that state on purpose
       * — via a backfill offer, or by booking somebody over their own stated
       * availability — rather than inheriting it from the fixture.
       */
      workingDayHours: 8,
    },
  });

  // orgRepo.create() creates the admin's membership as a side effect.
  const adminMembership = await prisma.membership.findFirstOrThrow({
    where: { organizationId: org.id, userId: adminUser.id },
  });

  const department = await prisma.department.create({
    data: { name: `Kitchen ${slug}`, organizationId: org.id, color: "#EF4444" },
  });

  async function addMember(
    label2: string,
    role: string,
    status: string,
    inDepartment: boolean
  ): Promise<TenantMember> {
    const user = await makeUser(label2, slug);
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: org.id,
        role,
        status,
        employmentType: role === "staff" ? "casual" : null,
      },
    });
    if (inDepartment) {
      await prisma.departmentMembership.create({
        data: { membershipId: membership.id, departmentId: department.id },
      });
    }
    return { userId: user.id, membershipId: membership.id, email: user.email };
  }

  const manager = await addMember("manager", "manager", "active", true);
  const staff = await addMember("staff", "staff", "active", true);
  const inactive = await addMember("inactive", "staff", "inactive", false);

  const outsiderUser = await makeUser("outsider", slug);

  return {
    orgId: org.id,
    orgSlug: slug,
    departmentId: department.id,
    admin: {
      userId: adminUser.id,
      membershipId: adminMembership.id,
      email: adminUser.email,
    },
    manager,
    staff,
    inactive,
    outsider: { userId: outsiderUser.id, email: outsiderUser.email },
  };
}

/**
 * Declares an open week for one or more members.
 *
 * Availability is a hard eligibility rule for anyone not contracted, and a
 * casual who has declared nothing is unavailable rather than unconstrained.
 * Since assignment gained a final eligibility gate, a suite about scheduling
 * conflicts or notifications fails on availability — the one rule it never
 * meant to exercise — unless it says out loud that these people are free.
 *
 * `skipDuplicates` because several suites already declare a week of their own
 * for the member they are actually testing.
 */
export async function declareOpenWeek(...membershipIds: string[]) {
  await prisma.availability.createMany({
    data: membershipIds.flatMap((membershipId) =>
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        membershipId,
        dayOfWeek,
        startTime: "00:00",
        endTime: "23:59",
        isAvailable: true,
      }))
    ),
    skipDuplicates: true,
  });
}

/** Suspends the organisation, for asserting the suspension gate. */
export async function suspendOrg(orgId: string) {
  await prisma.organization.update({
    where: { id: orgId },
    data: { status: "suspended" },
  });
}

/** A task in the tenant's department, for routes that need a real taskId. */
export async function createTask(tenant: Tenant, title = "Test Task") {
  return prisma.task.create({
    data: {
      title,
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      status: "open",
      priority: "medium",
      requiredHeadcount: 1,
    },
  });
}
