/**
 * Who should hear about a problem with a task.
 *
 * ## Why this is its own module
 *
 * Two separate events can put an assigned shift at risk:
 *
 *   1. a manager reschedules the task, so the people on it may no longer fit
 *   2. a staff member changes their availability, so they may no longer fit
 *
 * They are the same problem from opposite directions and must reach the same
 * people. Written inline twice they would drift — one would get a scoping fix
 * and the other would not, and nobody would notice because both would keep
 * sending notifications to somebody.
 *
 * ## Who, and why it is a permission rather than a job title
 *
 * This asked `role !== "manager"`, which is the authorisation model the
 * permission catalogue replaced everywhere else. It made the notification list
 * unreachable by the feature that is supposed to govern it: a member given a
 * custom role with `tasks:assign` — the person whose actual job is to fix the
 * shift this message is about — was not told, because their title was wrong.
 * A manager whose custom role removed it was told anyway.
 *
 * The question the notification asks is "who can put this right", and the
 * answer to that is `tasks:assign`. Anyone who can move people on and off the
 * task should hear that its people no longer fit; anyone who cannot is being
 * handed a problem they have no way to act on.
 *
 * ## The scoping rule, and why it is not "everyone who can assign"
 *
 * These notifications name a staff member and a task title. That is precisely
 * the data a department-scoped manager is not allowed to read from any
 * reporting endpoint — so sending it to them through the notification table
 * would reintroduce, by a side door, the leak that scoping closed at the front.
 *
 * Scope is `departmentScopeFor`, the same helper every route uses, so this
 * cannot come to disagree with them about who is scoped to what. `null` is
 * unrestricted — a company admin — and an array is that member's departments.
 *
 * A task with NO department reaches unrestricted members only. That matches
 * `AccessService.isTaskInScope`, which refuses a scoped manager a
 * department-less task: if nobody's scope contains it, no scoped member owns
 * it. An empty array is therefore not "everything" but "nothing", which is the
 * distinction that keeps "manager of the kitchen" from quietly becoming
 * "manager of everything".
 */
import { MembershipRepository } from "@/repositories/membership.repository";
import { departmentScopeFor } from "@/lib/department-scope";
import { permissionsOf } from "@/lib/permissions";

const membershipRepo = new MembershipRepository();

/** User ids to notify about a problem with `departmentId`'s task. */
export async function taskWatcherUserIds(
  organizationId: string,
  departmentId: string | null
): Promise<string[]> {
  const members = await membershipRepo.findByOrgId(organizationId);

  return members
    .filter((m) => m.status === "active")
    .filter((m) => permissionsOf(m).has("tasks:assign"))
    .filter((m) => {
      const scope = departmentScopeFor(m);
      if (scope === null) return true;
      if (departmentId === null) return false;
      return scope.includes(departmentId);
    })
    .map((m) => m.userId);
}
