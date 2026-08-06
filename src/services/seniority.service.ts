/**
 * Seniority Service (Control Layer)
 *
 * Turns "how many shifts has this person completed?" into a level the
 * composition engine can reason about, and lets a manager pin that level when
 * the count is wrong.
 *
 * The rules themselves are pure and live in `@/lib/seniority`. This service is
 * only the part that needs the database: the completed-shift counts, the
 * per-member pins, and the organisation's thresholds.
 *
 * ## Why one call for many members
 *
 * The candidate list evaluates every active member of an organisation at once.
 * A count query per member would put the cost of opening the assign dialog on
 * the size of the organisation, and it is the kind of thing that is fine with
 * the eight members in a demo seed and unusable at two hundred. Everything
 * here is three queries regardless of how many members are asked about.
 *
 * BCE: Service (Control) → Repository (Entity).
 */
import { MembershipRepository } from "@/repositories/membership.repository";
import { ReportingRepository } from "@/repositories/reporting.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import {
  assessSeniority,
  isSeniorityLevel,
  type SeniorityAssessment,
  type SeniorityThresholds,
} from "@/lib/seniority";
import { memberInScope } from "@/lib/department-scope";


export class SeniorityService {
  private membershipRepo = new MembershipRepository();
  private reportingRepo = new ReportingRepository();
  private settingsRepo = new SettingsRepository();
  private auditService = new AuditLogService();

  /**
   * The level in force for each of the given memberships, and why.
   *
   * `departmentId` scopes the shift count. Pass the task's department so a
   * kitchen veteran is not credited with kitchen experience when being
   * considered for the bar; pass null (the members page) for an org-wide view.
   * `departmentName` only reaches the explanation string, so an unnamed
   * department degrades to "12 completed shifts" rather than "12 completed
   * shifts in undefined".
   */
  async assessMany(
    organizationId: string,
    membershipIds: string[],
    departmentId?: string | null,
    departmentName?: string | null
  ): Promise<Record<string, SeniorityAssessment>> {
    if (membershipIds.length === 0) return {};

    const [counts, overrides, thresholds] = await Promise.all([
      this.reportingRepo.countCompletedShiftsByMember(
        organizationId,
        membershipIds,
        departmentId
      ),
      this.membershipRepo.getSeniorityOverrides(membershipIds),
      this.getThresholds(organizationId),
    ]);

    const result: Record<string, SeniorityAssessment> = {};
    for (const id of membershipIds) {
      result[id] = assessSeniority({
        override: overrides[id],
        completedShifts: counts[id] ?? 0,
        thresholds,
        departmentId: departmentId ?? null,
        departmentName: departmentId ? departmentName ?? null : null,
      });
    }
    return result;
  }

  /** Convenience for the single-member case; same three queries underneath. */
  async assessOne(
    organizationId: string,
    membershipId: string,
    departmentId?: string | null,
    departmentName?: string | null
  ): Promise<SeniorityAssessment> {
    const all = await this.assessMany(
      organizationId,
      [membershipId],
      departmentId,
      departmentName
    );
    return all[membershipId];
  }

  async getThresholds(organizationId: string): Promise<SeniorityThresholds> {
    const settings = await this.settingsRepo.getOrCreate(organizationId);
    return {
      experiencedShiftThreshold: settings.experiencedShiftThreshold,
      seniorShiftThreshold: settings.seniorShiftThreshold,
    };
  }

  /**
   * Pin a member's level, or pass null to release it back to derivation.
   *
   * Audited rather than merely written. This is a manager making a judgement
   * about a colleague that then decides which shifts that colleague can be put
   * on, so who changed it and when should be answerable — the same reason
   * eligibility overrides are recorded.
   */
  async setOverride(
    organizationId: string,
    membershipId: string,
    level: string | null,
    actorUserId?: string
  ) {
    if (level !== null && !isSeniorityLevel(level)) {
      throw new Error("Invalid seniority level");
    }

    const membership = await this.membershipRepo.findById(membershipId);
    // Cross-tenant guard. The id arrives from a request body, so belonging to
    // the caller's organisation has to be proved rather than assumed.
    if (!membership || membership.organizationId !== organizationId) {
      throw new Error("Member not found");
    }

    const updated = await this.membershipRepo.updateSeniorityOverride(
      membershipId,
      level
    );

    await this.auditService.log({
      organizationId,
      userId: actorUserId,
      action: ACTIONS.SENIORITY_OVERRIDDEN,
      entityType: "membership",
      entityId: membershipId,
      details: { from: membership.seniorityOverride ?? null, to: level },
    });

    return updated;
  }

  /**
   * Same as `setOverride`, addressed by user rather than membership.
   *
   * The member routes are keyed on `userId` — a membership id is an internal
   * identifier the UI has no reason to put in a URL. Resolving it here keeps
   * the Boundary layer out of the repositories, which is the BCE rule this
   * project holds to.
   *
   * The lookup includes inactive memberships on purpose: a deactivated member
   * can be reactivated, and their seniority should be correctable while they
   * are off the roster rather than only once they are back on it.
   */
  async setOverrideForUser(
    organizationId: string,
    userId: string,
    level: string | null,
    actorUserId?: string,
    /**
     * The caller's departments, or null/undefined for a company admin.
     *
     * Seniority feeds composition rules, so pinning it changes who satisfies a
     * staffing constraint. Without this a manager confined to Kitchen could
     * change a Front-of-House member's level and silently alter which shifts
     * that department could fill. Out of scope is reported as "not found", the
     * same convention `CertificationService` uses — a manager must not be able
     * to probe for members outside their own departments.
     */
    departmentScope?: string[] | null
  ) {
    const membership = await this.membershipRepo.findByUserAndOrgIncludingInactive(
      userId,
      organizationId
    );
    if (!membership) throw new Error("Member not found");
    if (!memberInScope(membership, departmentScope)) {
      throw new Error("Member not found");
    }

    return this.setOverride(organizationId, membership.id, level, actorUserId);
  }

  /**
   * Seniority for every member of an organisation, keyed by membership id.
   *
   * Counted org-wide, because the members page is not looking at any
   * particular shift. The per-department figure is what the assignment path
   * uses, and the two will legitimately differ — the UI says which it is
   * showing.
   */
  async assessOrganisation(
    organizationId: string,
    /** Manager scope. null/undefined = unrestricted (company admin). */
    departmentScope?: string[] | null
  ): Promise<Record<string, SeniorityAssessment>> {
    const members = await this.membershipRepo.findByOrgId(organizationId);
    // `GET /members` next door has been scoped from the start. This endpoint
    // returns the same roster's seniority judgements and was not, so a scoped
    // manager could read the whole company's levels through it instead.
    const visible = members.filter((m) => memberInScope(m, departmentScope));
    return this.assessMany(
      organizationId,
      visible.map((m) => m.id),
      null
    );
  }
}
