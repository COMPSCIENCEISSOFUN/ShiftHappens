/**
 * Platform Repository (Entity Layer)
 * 
 * Data access for platform-level queries across all organizations.
 * Used by the Platform Admin dashboard to manage tenants.
 * Unlike other repositories, queries here are NOT org-scoped —
 * they intentionally span all organizations.
 */
import { prisma } from "@/lib/prisma";

export class PlatformRepository {
  /**
   * Lists all organizations with member and task counts.
   *
   * The `select` is explicit on purpose. Without one, Prisma returns every
   * scalar on Organization — including `stripeCustomerId`,
   * `stripeSubscriptionId`, `subscriptionStatus`, `billingInterval` and
   * `address` — all of which reached the browser despite nothing rendering
   * them. No tenant's operational data was exposed (this query never traverses
   * into Membership, Task or User; the only relation is `_count`), but sending
   * a customer's payment-processor identifiers to a page that ignores them is
   * needless. Add a field here when the UI actually needs it.
   */
  async findAllOrganizations(limit = 50, offset = 0) {
    return prisma.organization.findMany({
      skip: offset,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        industry: true,
        status: true,
        subscriptionTier: true,
        createdAt: true,
        _count: {
          select: {
            memberships: true,
            tasks: true,
          },
        },
      },
    });
  }

  /** Counts total organizations */
  async countOrganizations() {
    return prisma.organization.count();
  }

  /** Gets a single organization by ID with counts */
  async findOrganizationById(orgId: string) {
    return prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        _count: {
          select: {
            memberships: true,
            tasks: true,
            departments: true,
          },
        },
      },
    });
  }

  /** Updates an organization's status (active/suspended) */
  async updateOrganizationStatus(orgId: string, status: string) {
    return prisma.organization.update({
      where: { id: orgId },
      data: { status },
    });
  }

  /**
   * Gets platform-wide statistics.
   *
   * `tierCounts` is grouped in the database rather than counted in the browser.
   * The dashboard used to fetch the entire organisation list purely to derive
   * three numbers from it, which meant the page got slower with every customer
   * signed — and only ever showed the first page of organisations, so the
   * numbers would have quietly gone wrong past fifty of them.
   *
   * Returned as a plain map with no assumed keys. A tier the UI does not know
   * about still appears here, which is what lets the dashboard notice it rather
   * than drop it from a hardcoded list of three.
   */
  async getStats() {
    const [orgCount, userCount, taskCount, activeOrgCount, tierGroups] =
      await Promise.all([
        prisma.organization.count(),
        prisma.user.count(),
        prisma.task.count(),
        prisma.organization.count({ where: { status: "active" } }),
        prisma.organization.groupBy({
          by: ["subscriptionTier"],
          _count: { _all: true },
        }),
      ]);

    const tierCounts: Record<string, number> = {};
    for (const group of tierGroups) {
      tierCounts[group.subscriptionTier] = group._count._all;
    }

    return {
      totalOrganizations: orgCount,
      activeOrganizations: activeOrgCount,
      totalUsers: userCount,
      totalTasks: taskCount,
      tierCounts,
    };
  }
}