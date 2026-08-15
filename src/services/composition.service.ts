/**
 * Composition Service (Control Layer)
 *
 * Assembles what a composition rule needs to know about each person on a
 * shift — their seniority, their valid certificates, their employment type —
 * and evaluates the task's rules over the whole set.
 *
 * The rules themselves are pure and live in `@/lib/composition-rules`. This
 * service exists because evaluating them needs four different repositories,
 * and because two callers need exactly the same set built exactly the same
 * way: `assignStaff`, which must refuse an assignment that puts a rule beyond
 * reach, and the task view, which shows whether the shift as it stands
 * satisfies them.
 *
 * BCE: Service (Control) → Repository (Entity).
 */
import { CertificationRepository } from "@/repositories/certification.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { SeniorityService } from "@/services/seniority.service";
import {
  evaluateComposition,
  parseCompositionRules,
  type CompositionCandidate,
  type CompositionEvaluation,
  type CompositionRule,
} from "@/lib/composition-rules";
import { occupiesSlot } from "@/lib/assignment-status";
import { canBeRostered } from "@/lib/role-config";

/**
 * Everything `openCompositionGate` needs for one task, gathered in one pass.
 *
 * Separated from the gate itself so the decision logic stays pure and testable
 * without a database, and so a caller filling a week pays for this once per task
 * rather than once per person it considers.
 */
export interface CompositionGateData {
  rules: CompositionRule[];
  requiredHeadcount: number;
  /** Already occupying a slot — the roster the proposals are added to. */
  assigned: CompositionCandidate[];
  /** Everyone the caller may propose, by membership id. */
  byMembership: Map<string, CompositionCandidate>;
}



export class CompositionService {
  private taskRepo = new TaskRepository();
  private membershipRepo = new MembershipRepository();
  private certRepo = new CertificationRepository();
  private seniorityService = new SeniorityService();

  /**
   * Reduce a set of memberships to what the rules look at.
   *
   * Seniority is scoped to `departmentId` — the shift's own department — so
   * experience is counted where it is relevant rather than org-wide.
   */
  async buildCandidates(
    organizationId: string,
    membershipIds: string[],
    departmentId: string | null,
    departmentName?: string | null
  ): Promise<CompositionCandidate[]> {
    const unique = [...new Set(membershipIds)];
    if (unique.length === 0) return [];

    const [seniority, certifications, memberships] = await Promise.all([
      this.seniorityService.assessMany(
        organizationId,
        unique,
        departmentId,
        departmentName
      ),
      this.certRepo.getValidCertificationNamesFor(unique),
      this.membershipRepo.findManyWithNames(unique),
    ]);

    const byId = new Map(memberships.map((m) => [m.id, m]));

    return unique.map((id) => {
      const membership = byId.get(id);
      return {
        membershipId: id,
        memberName: membership?.name ?? undefined,
        // A membership that vanished between the assignment list being read
        // and this running has no employment type and no history, so it
        // evaluates as the least qualified thing it could be. Rules then
        // refuse rather than quietly pass — the safe direction when the
        // subject of the rule is missing.
        seniority: seniority[id]?.level ?? "junior",
        certifications: certifications[id] ?? [],
        employmentType: membership?.employmentType ?? null,
      };
    });
  }

  /**
   * Evaluate a task's rules over the people on it, optionally plus a proposed
   * addition.
   *
   * `additionalMembershipIds` is what makes this usable as a gate: it answers
   * "what would the roster look like if I assigned these people?" without
   * writing anything.
   */
  async evaluateForTask(
    taskId: string,
    additionalMembershipIds: string[] = []
  ): Promise<CompositionEvaluation & { candidates: CompositionCandidate[] }> {
    const task = await this.taskRepo.findById(taskId);
    if (!task) throw new Error("Task not found");

    const rules = parseCompositionRules(task.compositionRules);

    const assigned = task.assignments
      .filter((a) => occupiesSlot(a.status))
      .map((a) => a.membershipId);

    const candidates = await this.buildCandidates(
      task.organizationId,
      [...assigned, ...additionalMembershipIds],
      task.departmentId,
      task.department?.name ?? null
    );

    return {
      ...evaluateComposition(rules, candidates, task.requiredHeadcount),
      candidates,
    };
  }

  /**
   * Everything the assign screen needs to annotate its candidate list.
   *
   * ## Why the client finishes the job
   *
   * The useful question is not "does this shift satisfy its rules right now" —
   * it is "if I tick this person, what happens?", and the answer changes with
   * every tick. Sending the rules and each person's attributes lets the panel
   * re-answer it as the manager selects, using the same pure functions the
   * server enforces with. Recomputing on the server would be a request per
   * click, and the alternative — annotating once when the panel opens — goes
   * stale the moment anything is selected.
   *
   * ## Population
   *
   * Deliberately the same set the eligibility engine evaluates: active,
   * rosterable members of the task's department, PLUS anyone already holding a
   * live assignment whatever department they are in. The second half matters
   * for the same reason it does there — a task moved between departments leaves
   * its assignees behind, and a rule judging the shift has to see them.
   *
   * These are two separate implementations of one population, so
   * tests/services/composition-annotations.test.ts asserts they agree. If that
   * test fails, the engine's filter moved and this must follow it.
   */
  async describeForTask(taskId: string, organizationId: string) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) {
      throw new Error("Task not found");
    }

    const rules = parseCompositionRules(task.compositionRules);
    const assignedMembershipIds = task.assignments
      .filter((a) => occupiesSlot(a.status))
      .map((a) => a.membershipId);

    // No rules means nothing to annotate, and describing every member would be
    // three queries for a panel that will render none of it.
    if (rules.length === 0) {
      return {
        rules,
        requiredHeadcount: task.requiredHeadcount,
        assignedMembershipIds,
        members: [] as CompositionCandidate[],
      };
    }

    const all = await this.membershipRepo.findByOrgId(organizationId);
    const rosterable = all.filter(
      (m) => m.status === "active" && canBeRostered(m.role)
    );

    const committed = new Set(assignedMembershipIds);
    const population = task.departmentId
      ? rosterable.filter(
          (m) =>
            committed.has(m.id) ||
            (m.departmentMemberships ?? []).some(
              (dm: { department: { id: string } }) =>
                dm.department.id === task.departmentId
            )
        )
      : rosterable;

    return {
      rules,
      requiredHeadcount: task.requiredHeadcount,
      assignedMembershipIds,
      members: await this.buildCandidates(
        organizationId,
        population.map((m) => m.id),
        task.departmentId,
        task.department?.name ?? null
      ),
    };
  }

  /**
   * Gather what a batch writer needs to judge many proposals against one task.
   *
   * Returns `null` when the task has no composition rules, which is the common
   * case and lets the caller skip the whole mechanism rather than build a gate
   * that would admit everybody.
   *
   * `possibleMembershipIds` is everyone the caller might propose. Building the
   * whole set up front is the point: seniority, valid certificates and
   * employment type are three queries however many people are in them, so one
   * call here replaces one per person considered.
   */
  async buildGateData(
    taskId: string,
    possibleMembershipIds: string[]
  ): Promise<CompositionGateData | null> {
    const task = await this.taskRepo.findById(taskId);
    if (!task) return null;

    const rules = parseCompositionRules(task.compositionRules);
    if (rules.length === 0) return null;

    const assignedIds = task.assignments
      .filter((a) => occupiesSlot(a.status))
      .map((a) => a.membershipId);

    // One build for both groups, so the assigned and the proposed are described
    // by the same code with the same department scoping. Splitting them into two
    // calls would be two chances for those to drift apart.
    const everyone = await this.buildCandidates(
      task.organizationId,
      [...assignedIds, ...possibleMembershipIds],
      task.departmentId,
      task.department?.name ?? null
    );

    const byId = new Map(everyone.map((c) => [c.membershipId, c]));
    const assignedSet = new Set(assignedIds);

    return {
      rules,
      requiredHeadcount: task.requiredHeadcount,
      assigned: everyone.filter((c) => assignedSet.has(c.membershipId)),
      // Anyone already on the shift is deliberately absent here. They hold a row
      // already, so proposing them is a duplicate the unique constraint would
      // refuse anyway — and admitting them would count one person twice against
      // every rule.
      byMembership: new Map(
        [...byId].filter(([id]) => !assignedSet.has(id))
      ),
    };
  }
}
