/**
 * SubscriptionRepository — Entity layer for subscription tier queries.
 * Handles reading the org tier and counting resources against tier limits.
 * All queries are org-scoped for multi-tenant isolation.
 */

import { prisma } from '@/lib/prisma';

export interface ResourceCounts {
  members: number;
  activeTasks: number;
  departments: number;
  workRules: number;
  customRoles: number;
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
   * Count all resources that are subject to tier limits.
   * - members: active memberships (status = 'active')
   * - activeTasks: tasks not completed or cancelled
   * - departments: all departments in org
   * - workRules: all work rules in org (active or inactive)
   * - customRoles: roles where isSystemRole = false
   */
  async getResourceCounts(organizationId: string): Promise<ResourceCounts> {
    const [members, activeTasks, departments, workRules, customRoles] =
      await Promise.all([
        this.countBillableMembers(organizationId),
        prisma.task.count({
          where: {
            organizationId,
            status: { notIn: ['completed', 'cancelled'] },
          },
        }),
        prisma.department.count({
          where: { organizationId },
        }),
        prisma.workRule.count({
          where: { organizationId },
        }),
        prisma.role.count({
          where: { organizationId, isSystemRole: false },
        }),
      ]);

    return { members, activeTasks, departments, workRules, customRoles };
  }

  /**
   * Count a single resource type. More efficient when only one check is needed.
   */
  async countResource(
    organizationId: string,
    resource: 'members' | 'active_tasks' | 'departments' | 'work_rules' | 'custom_roles'
  ): Promise<number> {
    switch (resource) {
      case 'members':
        return this.countBillableMembers(organizationId);
      case 'active_tasks':
        return prisma.task.count({
          where: {
            organizationId,
            status: { notIn: ['completed', 'cancelled'] },
          },
        });
      case 'departments':
        return prisma.department.count({
          where: { organizationId },
        });
      case 'work_rules':
        return prisma.workRule.count({
          where: { organizationId },
        });
      case 'custom_roles':
        return prisma.role.count({
          where: { organizationId, isSystemRole: false },
        });
    }
  }

  private async countBillableMembers(organizationId: string): Promise<number> {
    const now = new Date();
    const [activeMemberships, validPendingInvitations] = await Promise.all([
      prisma.membership.count({ where: { organizationId, status: 'active' } }),
      prisma.invitationToken.count({
        where: { organizationId, acceptedAt: null, expires: { gt: now } },
      }),
    ]);
    return activeMemberships + validPendingInvitations;
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
