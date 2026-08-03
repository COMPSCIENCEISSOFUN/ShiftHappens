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
 * ## The scoping rule, and why it is not "every manager"
 *
 * These notifications name a staff member and a task title. That is precisely
 * the data a department-scoped manager is not allowed to read from any
 * reporting endpoint — so sending it to them through the notification table
 * would reintroduce, by a side door, the leak that scoping closed at the front.
 *
 * Recipients are therefore:
 *
 *   - every active company admin, who is unscoped by design; plus
 *   - every active manager who belongs to the task's department.
 *
 * A task with NO department reaches company admins only. That matches
 * `AccessService.isTaskInScope`, which refuses a scoped manager a
 * department-less task: if nobody's scope contains it, no scoped manager
 * owns it.
 */
import { MembershipRepository } from "@/repositories/membership.repository";

const membershipRepo = new MembershipRepository();

/** User ids to notify about a problem with `departmentId`'s task. */
export async function taskWatcherUserIds(
  organizationId: string,
  departmentId: string | null
): Promise<string[]> {
  const members = await membershipRepo.findByOrgId(organizationId);

  return members
    .filter((m) => m.status === "active")
    .filter((m) => {
      if (m.role === "company_admin") return true;
      if (m.role !== "manager") return false;
      // An unscoped manager — one in no department — is not treated as
      // universal. Being in no department means owning no shifts, not owning
      // all of them; the permissive reading is how "manager of the kitchen"
      // quietly becomes "manager of everything".
      if (departmentId === null) return false;
      return (m.departmentMemberships ?? []).some(
        (dm) => dm.department.id === departmentId
      );
    })
    .map((m) => m.userId);
}
