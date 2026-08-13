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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
    /*
     * Two 30-day windows, so growth can be stated as a CHANGE rather than as a
     * number with nothing to compare it against. "8 new organisations" is a
     * fact; "8, up from 3" is the thing somebody running a platform actually
     * wants to know, and the second window costs one more count.
     *
     * Both boundaries are computed once here rather than per query, so every
     * figure on the dashboard is measured against the same instant — otherwise
     * two counts a few milliseconds apart can disagree about which side of the
     * boundary a row falls on.
     */
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const priorWindow = { gte: sixtyDaysAgo, lt: thirtyDaysAgo };

    const [
      orgCount,
      userCount,
      taskCount,
      activeOrgCount,
      tierGroups,
      // Revenue is grouped by BOTH columns because the same tier bills at two
      // different amounts; a tier count alone cannot price itself.
      billingGroups,
      newOrgs,
      priorNewOrgs,
      newUsers,
      priorNewUsers,
      completedTasks,
      reviewStats,
      openFeedback,
      pastDueOrgs,
    ] = await Promise.all([
      prisma.organization.count(),
      prisma.user.count(),
      prisma.task.count(),
      prisma.organization.count({ where: { status: "active" } }),
      prisma.organization.groupBy({
        by: ["subscriptionTier"],
        _count: { _all: true },
      }),
      prisma.organization.groupBy({
        by: ["subscriptionTier", "billingInterval"],
        _count: { _all: true },
      }),
      prisma.organization.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.organization.count({ where: { createdAt: priorWindow } }),
      prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      prisma.user.count({ where: { createdAt: priorWindow } }),
      prisma.task.count({ where: { status: "completed" } }),
      /*
       * Approved reviews only. A pending review has not been judged fit to
       * publish, and averaging it into a headline number would let anybody with
       * an account move the platform's rating before a human had looked at it.
       */
      prisma.review.aggregate({
        where: { status: "approved" },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      prisma.feedback.count({ where: { archivedAt: null } }),
      /*
       * Money that has stopped arriving. `past_due` and `unpaid` are payment
       * failures at different stages and both mean somebody should act; a
       * platform dashboard that reports revenue without reporting the part of
       * it that is failing is reporting a wish.
       */
      prisma.organization.count({
        where: { subscriptionStatus: { in: ["past_due", "unpaid"] } },
      }),
    ]);

    const tierCounts: Record<string, number> = {};
    for (const group of tierGroups) {
      tierCounts[group.subscriptionTier] = group._count._all;
    }

    /*
     * Returned as a breakdown rather than as a figure, deliberately.
     *
     * Prices live in `subscription-tiers.ts`, which is the Control layer's
     * business configuration — a repository that imported it to multiply rows
     * by dollars would be deciding what a plan costs from inside the data
     * access layer, and the price would then be defined in two places the first
     * time anybody changed one. This says how many of each (tier, interval)
     * pair exist; the service prices them.
     */
    const billingBreakdown = billingGroups.map((group) => ({
      tier: group.subscriptionTier,
      interval: group.billingInterval,
      count: group._count._all,
    }));

    return {
      totalOrganizations: orgCount,
      activeOrganizations: activeOrgCount,
      totalUsers: userCount,
      totalTasks: taskCount,
      tierCounts,
      billingBreakdown,
      newOrganizations: newOrgs,
      previousNewOrganizations: priorNewOrgs,
      newUsers,
      previousNewUsers: priorNewUsers,
      completedTasks,
      averageRating: reviewStats._avg.rating,
      reviewCount: reviewStats._count._all,
      openFeedback,
      pastDueOrganizations: pastDueOrgs,
    };
  }
}