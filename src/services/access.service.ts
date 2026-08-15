/**
 * Access Service (Control Layer)
 *
 * Owns every authorisation lookup the Boundary layer needs: "is this user a
 * member of this organisation", "is this organisation active", and "is this
 * task within the caller's department scope".
 */
import { MembershipRepository } from "@/repositories/membership.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import {
  departmentScopeFor,
  isDepartmentInScope,
  type ScopableMembership,
} from "@/lib/department-scope";
import {
  permissionsOf,
  type PermissionedMembership,
} from "@/lib/permissions";

export type { PermissionedMembership };

export class AccessService {
  private membershipRepo = new MembershipRepository();
  private orgRepo = new OrganizationRepository();
  private taskRepo = new TaskRepository();
  private assignmentRepo = new TaskAssignmentRepository();

  /**
   * The caller's ACTIVE membership in an organisation, or null.
   *
   * Null means "not a member, or no longer one" — routes must treat both the
   * same way and answer 403. The active-only filter lives in the repository
   * (`findByUserAndOrg`); this method exists so no route has to know that.
   *
   * There is deliberately no `…IncludingInactive` counterpart here. That
   * variant is for *administering* a member who may be deactivated, which is a
   * `UserManagementService` concern, never an authorisation one. Leaving it out
   * of the access surface means a route cannot reach for it by mistake.
   */
  async getMembership(userId: string, organizationId: string) {
    return this.membershipRepo.findByUserAndOrg(userId, organizationId);
  }

  /**
   * What this member is actually allowed to do.
   *
   * Derived from the membership already loaded by `getMembership`, which
   * resolves the custom role's permissions in the same query — so this costs
   * nothing and, more importantly, cannot read a different membership from the
   * one the route authorised.
   *
   * Note the distinction the null carries: a member with NO custom role falls
   * back to their system role's bundle, while a member holding a custom role
   * with no permissions gets nothing. Collapsing those two would make an empty
   * role silently behave like no role at all, and an admin who deliberately
   * composed a role that grants nothing would find it granted everything their
   * system role did.
   *
   * The rule itself lives in `lib/permissions` so that callers outside Control
   * — the notification watcher list, which asks it of every member at once —
   * can reach it without going through an authorisation service that is not
   * authorising anything. This stays as the name routes already use.
   */
  permissionsFor(membership: PermissionedMembership): Set<string> {
    return permissionsOf(membership);
  }

  /**
   * May this user sign in, as far as organisation suspension is concerned?
   *
   * True when they belong to no organisation yet — onboarding, or invited but
   * not yet placed — and true when at least one of theirs is active. False only
   * when they belong to organisations and every one of them is suspended.
   *
   * Here rather than in `lib/auth.ts`, which was querying the membership table
   * directly. That file sits on the Boundary path for every route in the
   * application, so the query was a Boundary→Entity access in the busiest
   * possible place.
   */
  async maySignIn(userId: string): Promise<boolean> {
    const statuses = await this.membershipRepo.findActiveOrgStatuses(userId);
    if (statuses.length === 0) return true;
    return statuses.some((status) => status === "active");
  }

  /**
   * Whether an organisation is active (i.e. not suspended, and exists).
   *
   * A missing organisation is reported as inactive rather than throwing: a
   * caller asking about an org that does not exist should be refused for the
   * same reason as one asking about a suspended org, and must not be able to
   * tell the two apart.
   */
  async isOrgActive(organizationId: string): Promise<boolean> {
    const status = await this.orgRepo.getStatus(organizationId);
    return status === "active";
  }

  /**
   * Whether a member may act on a task under department scoping.
   *
   * Company admins are unrestricted. A scoped member may only touch tasks in
   * one of their departments, and a task with no department is out of scope for
   * anyone who is scoped. A missing task returns false, so the caller answers
   * 403/404 rather than leaking that the id does not exist.
   *
   * ⚠️ This is a SCOPE check, not a tenancy check. It says nothing about which
   * organisation the task belongs to, and returns true for a company admin
   * before the task is even loaded. Always pair it with an org-scoped lookup —
   * `TaskService.getById(taskId, orgId)` — or a cross-tenant id will pass.
   */
  async isTaskInScope(
    taskId: string,
    membership: ScopableMembership
  ): Promise<boolean> {
    const scope = departmentScopeFor(membership);
    if (scope === null) return true;

    const departmentId = await this.taskRepo.getDepartmentId(taskId);
    if (departmentId === undefined) return false;
    return isDepartmentInScope(departmentId, scope);
  }

  /**
   * The same scope rule, resolved through an assignment's task.
   * Carries the same caveat as `isTaskInScope`: scope, not tenancy.
   */
  async isAssignmentTaskInScope(
    assignmentId: string,
    membership: ScopableMembership
  ): Promise<boolean> {
    const scope = departmentScopeFor(membership);
    if (scope === null) return true;

    const departmentId =
      await this.assignmentRepo.getTaskDepartmentId(assignmentId);
    if (departmentId === undefined) return false;
    return isDepartmentInScope(departmentId, scope);
  }
}
