import { NextRequest, NextResponse } from "next/server";
import { checkOrgSuspended, getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { requireAnyPermission, requirePermission } from "@/lib/permission-guard";
import { TASK_LIST_READERS } from "@/lib/permissions";
import { updateProjectSchema } from "@/lib/validations";
import { ProjectService } from "@/services/project.service";
import { planRefusal } from "@/lib/api-utils";

const projects = new ProjectService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string; projectId: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return unauthorizedResponse();
  const { orgId, projectId } = await params;
  const gate = await requireAnyPermission(user.id, orgId, TASK_LIST_READERS);
  if (!gate.ok) return gate.response;
  const membership = gate.membership;
  const project = await projects.get(projectId, orgId);
  const privateProject = project?.staffingMode === "project_team";
  const participant = project?.projectMembers.some((member) => member.membershipId === membership.id);
  const canAccess = membership.role === "company_admin" || (!privateProject || project?.createdById === user.id || participant);
  if (!project || !isDepartmentInScope(project.departmentId, departmentScopeFor(membership)) || !canAccess) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(project);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ orgId: string; projectId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId, projectId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;
    const gate = await requirePermission(user.id, orgId, "tasks:update");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;
    const current = await projects.get(projectId, orgId);
    if (!current || !isDepartmentInScope(current.departmentId, departmentScopeFor(membership))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const parsed = updateProjectSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    const nextDepartmentId = parsed.data.departmentId ?? current.departmentId;
    if (!isDepartmentInScope(nextDepartmentId, departmentScopeFor(membership))) return NextResponse.json({ error: "Project department is outside your scope." }, { status: 403 });
    return NextResponse.json(await projects.update(projectId, orgId, parsed.data, user.id));
  } catch (error) {
    // A plan refusal (`projects` is Pro and above) is a 403 with the plan's
    // own message — not the 400 this branch answers a bad input with.
    const plan = planRefusal(error);
    if (plan) return plan;

    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update project" }, { status: 400 });
  }
}

/**
 * DELETE — remove a project. Its work items survive as ordinary tasks.
 *
 * Gated on `tasks:delete` rather than the `tasks:update` that PATCH uses:
 * renaming a project and dissolving one are different acts, and somebody
 * trusted to keep a project's details current is not automatically trusted to
 * remove it. The department scope check is the same one PATCH applies, so a
 * manager cannot delete a project outside their departments.
 */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ orgId: string; projectId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId, projectId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;
    const gate = await requirePermission(user.id, orgId, "tasks:delete");
    if (!gate.ok) return gate.response;
    const current = await projects.get(projectId, orgId);
    if (!current || !isDepartmentInScope(current.departmentId, departmentScopeFor(gate.membership))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(await projects.remove(projectId, orgId, user.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete project";
    return NextResponse.json({ error: message }, { status: message === "Project not found" ? 404 : 400 });
  }
}
