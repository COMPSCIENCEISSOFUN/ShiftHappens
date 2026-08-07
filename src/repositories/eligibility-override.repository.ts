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
      where: { taskId },
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
        overriddenBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  /** Gets all overrides for a specific member */
  async findByMembershipId(membershipId: string) {
    return prisma.eligibilityOverride.findMany({
      where: { membershipId },
      include: {
        task: { select: { id: true, title: true } },
        overriddenBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      where: { taskId, membershipId, ruleOverridden },
    });
    return count > 0;
  }

  /**
   * The keys that mean "a person was asked to work when they had said they
   * were not available".
   *
   * `all` is here alongside `availability` because the assign screen wrote it
   * for every kind of waiver before the screen learned to name the rule it was
   * waiving. Those rows cannot be told apart after the fact, so they are
   * treated as availability waivers — which errs toward asking the member
   * rather than booking them, the safe direction for a guess about consent.
   */
  static readonly CONSENT_RULES = ["availability", "all"] as const;

  /**
   * How many times each member has been asked despite declaring themselves
   * unavailable, since `since`.
   *
   * One grouped query rather than a count per member: this feeds the assign
   * panel, which renders every candidate, and a per-row count would be an N+1
   * on the screen a manager opens most.
   */
  async countConsentOverrides(
    membershipIds: string[],
    since: Date
  ): Promise<Map<string, number>> {
    if (membershipIds.length === 0) return new Map();

    const rows = await prisma.eligibilityOverride.groupBy({
      by: ["membershipId"],
      where: {
        membershipId: { in: membershipIds },
        ruleOverridden: { in: [...EligibilityOverrideRepository.CONSENT_RULES] },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });

    return new Map(rows.map((r) => [r.membershipId, r._count._all]));
  }

  /**
   * Task ids this member was waved onto despite being unavailable.
   *
   * Read by the acceptance-rate calculation, which must not count a decline of
   * one of these against them — see `ReportingService`.
   */
  async consentOverriddenTaskIds(
    membershipId: string,
    since: Date
  ): Promise<Set<string>> {
    const rows = await prisma.eligibilityOverride.findMany({
      where: {
        membershipId,
        ruleOverridden: { in: [...EligibilityOverrideRepository.CONSENT_RULES] },
        createdAt: { gte: since },
      },
      select: { taskId: true },
    });
    return new Set(rows.map((r) => r.taskId));
  }
}
