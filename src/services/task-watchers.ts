/**
 * Who should hear about a problem with a task.
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
