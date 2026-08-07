/**
 * EligibilityOverride Repository (Entity Layer)
 * 
 * Data access layer for eligibility rule overrides.
 * When a staff member is blocked by the eligibility engine
 * (hours limit, certification, or availability), a manager
 * can override with a documented reason.
 * 
 * Overrides are per-task, per-member, and tracked for audit.
 */
import { prisma } from "@/lib/prisma";

export class EligibilityOverrideRepository {
  /** Creates an eligibility override */
  async create(data: {
    taskId: string;
    membershipId: string;
    overriddenById: string;
    reason: string;
    ruleOverridden: string;
    expiresAt?: Date;
  }) {
    return prisma.eligibilityOverride.create({
      data,
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
        overriddenBy: { select: { id: true, name: true } },
      },
    });
  }

  /** Gets all overrides for a specific task */
  async findByTaskId(taskId: string) {
    return prisma.eligibilityOverride.findMany({
      where: {
        taskId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
        overriddenBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Gets all overrides for a specific member */
  async findByMembershipId(membershipId: string) {
    return prisma.eligibilityOverride.findMany({
      where: {
        membershipId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        task: { select: { id: true, title: true } },
        overriddenBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Checks if an override exists for a specific member, task, and rule.
   * Used by the eligibility engine to skip blocked rules.
   */
  async hasOverride(
    taskId: string,
    membershipId: string,
    ruleOverridden: string
  ): Promise<boolean> {
    const count = await prisma.eligibilityOverride.count({
      where: {
        taskId,
        membershipId,
        ruleOverridden,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    return count > 0;
  }
}
