import { NextRequest, NextResponse } from "next/server";
import { checkOrgSuspended, getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";
import { updateProjectSchema } from "@/lib/validations";
import { MembershipRepository } from "@/repositories/membership.repository";
import { ProjectService } from "@/services/project.service";

const memberships = new MembershipRepository();
const projects = new ProjectService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string; projectId: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return unauthorizedResponse();
  const { orgId, projectId } = await params;
  const membership = await memberships.findByUserAndOrg(user.id, orgId);
  if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const project = await projects.get(projectId, orgId);
  if (!project || !isDepartmentInScope(project.departmentId, departmentScopeFor(membership))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(project);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ orgId: string; projectId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId, projectId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;
    const membership = await memberships.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_UPDATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const current = await projects.get(projectId, orgId);
    if (!current || !isDepartmentInScope(current.departmentId, departmentScopeFor(membership))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const parsed = updateProjectSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    const nextDepartmentId = parsed.data.departmentId ?? current.departmentId;
    if (!isDepartmentInScope(nextDepartmentId, departmentScopeFor(membership))) return NextResponse.json({ error: "Project department is outside your scope." }, { status: 403 });
    return NextResponse.json(await projects.update(projectId, orgId, parsed.data, user.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update project" }, { status: 400 });
  }
}
