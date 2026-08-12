/**
 * SubscriptionRepository — Entity layer for subscription tier queries.
 * Handles reading the org tier and counting resources against tier limits.
 * All queries are org-scoped for multi-tenant isolation.
 */

import { prisma } from '@/lib/prisma';
import type { ResourceType } from '@/lib/subscription-tiers';

export interface ResourceCounts {
  members: number;
  activeTasks: number;
  departments: number;
  workRules: number;
  customRoles: number;
  projects: number;
}

export class SubscriptionRepository {
  /**
   * Get the subscription tier for an organization.
   * Returns the raw tier string from the database.
   */
  async getOrganizationTier(organizationId: string): Promise<string> {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { subscriptionTier: true },
    });

    if (!org) {
      throw new Error('Organization not found');
    }

    return org.subscriptionTier;
  }

  /**
   * The tier AND any purchased quota, in one read.
   *
   * Separate from `getOrganizationTier` because most callers only gate on the
   * tier, but the two that compute a limit — the enforcement check and the
   * usage panel — need both, and must not disagree about either. Fetching them
   * together is what stops the panel reporting a cap the check does not apply.
   */
  async getPlanState(
    organizationId: string
  ): Promise<{ tier: string; projectQuotaAddon: number }> {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { subscriptionTier: true, projectQuotaAddon: true },
    });

    if (!org) {
      throw new Error('Organization not found');
    }

    return {
      tier: org.subscriptionTier,
      projectQuotaAddon: org.projectQuotaAddon,
    };
  }

  /**
   * Set the purchased project quota. Written from verified Stripe events only —
   * never from a client, for the same reason the tier is not.
   */
  async setProjectQuotaAddon(
    organizationId: string,
    quantity: number
  ): Promise<void> {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { projectQuotaAddon: Math.max(0, quantity) },
    });
  }

  /**
   * Count all resources that are subject to tier limits.
   * - members: active memberships (status = 'active')
   * - activeTasks: tasks not completed or cancelled
   * - departments: ACTIVE departments — archived ones do not count
   * - workRules: all work rules in org (active or paused)
   * - customRoles: roles where isSystemRole = false
   *
   * The archived-department exclusion was a fix, not a preference. Departments
   * are soft-deleted (`archivedAt`), and this counted them regardless — so an
   * organisation on the Free plan, whose limit is two, could archive both and
   * still be refused a third. Archiving is the only way the product offers to
   * get under the limit, and it did not work.
   *
   * Paused work rules DO still count, which is deliberate and matches how
   * `members` treats a deactivated member's seat: pausing is a temporary state
   * a rule returns from, not a deletion. Deleting the rule frees the slot.
   */
  async getResourceCounts(organizationId: string): Promise<ResourceCounts> {
    const [members, activeTasks, departments, workRules, customRoles, projects] =
      await Promise.all([
        prisma.membership.count({
          where: { organizationId, status: 'active' },
        }),
        prisma.task.count({
          where: {
            organizationId,
            status: { notIn: ['completed', 'cancelled'] },
          },
        }),
        prisma.department.count({
          where: { organizationId, archivedAt: null },
        }),
        prisma.workRule.count({
          where: { organizationId },
        }),
        prisma.role.count({
          where: { organizationId, isSystemRole: false },
        }),
        /*
         * Every project counts, whatever its status. A completed project is
         * unlike a completed TASK: the tasks, members and departments hang off
         * it and stay reachable through it, so it is still occupying the thing
         * the limit is counting. Excluding finished ones would also hand any
         * organisation unlimited projects for the price of marking them done.
         */
        prisma.project.count({
          where: { organizationId },
        }),
      ]);

    return { members, activeTasks, departments, workRules, customRoles, projects };
  }

  /**
   * Count a single resource type. More efficient when only one check is needed.
   */
  async countResource(
    organizationId: string,
    // Typed from RESOURCE_TYPES rather than repeated inline, so adding a
    // resource fails to compile here until this switch handles it.
    resource: ResourceType
  ): Promise<number> {
    switch (resource) {
      case 'members':
        return prisma.membership.count({
          where: { organizationId, status: 'active' },
        });
      case 'active_tasks':
        return prisma.task.count({
          where: {
            organizationId,
            status: { notIn: ['completed', 'cancelled'] },
          },
        });
      case 'departments':
        // Must match getResourceCounts above — the two answer the same
        // question and a difference between them would show one number on the
        // usage panel and enforce a different one on create.
        return prisma.department.count({
          where: { organizationId, archivedAt: null },
        });
      case 'work_rules':
        return prisma.workRule.count({
          where: { organizationId },
        });
      case 'custom_roles':
        return prisma.role.count({
          where: { organizationId, isSystemRole: false },
        });
      case 'projects':
        // Must match getResourceCounts above — same question, same answer.
        return prisma.project.count({
          where: { organizationId },
        });
    }
  }

  /**
   * Update the subscription tier for an organization.
   * Used by platform admin to set/override tiers.
   */
  async updateOrganizationTier(
    organizationId: string,
    tier: string
  ): Promise<{ id: string; name: string; subscriptionTier: string }> {
    return prisma.organization.update({
      where: { id: organizationId },
      data: { subscriptionTier: tier },
      select: { id: true, name: true, subscriptionTier: true },
    });
  }
}