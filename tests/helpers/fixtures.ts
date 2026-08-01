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
      allocationMode: "auto",
      breakRuleHoursWorked: 8,
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
