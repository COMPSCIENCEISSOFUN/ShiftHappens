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
 * ## Why the whole set, every time
 *
 * A composition rule is a property of the group. Checking only the person
 * being added would let two separately-fine assignments produce a roster that
 * breaks a rule neither of them broke alone — which is the exact failure the
 * per-candidate eligibility engine already has and the reason this is
 * separate from it.
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
} from "@/lib/composition-rules";

/**
 * Statuses that occupy a slot, matching `countActiveByTaskId`.
 *
 * `withdrawal_requested` counts: the member is still on the shift until a
 * manager resolves the request, and treating them as gone would let a
 * replacement be assigned into a seat that is not free.
 */
const OCCUPYING = ["pending", "accepted", "withdrawal_requested"];

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
      .filter((a) => OCCUPYING.includes(a.status))
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
}
