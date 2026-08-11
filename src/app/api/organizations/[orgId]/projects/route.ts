import { NextRequest, NextResponse } from "next/server";
import { checkOrgSuspended, getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";
import { createProjectSchema } from "@/lib/validations";
import { MembershipRepository } from "@/repositories/membership.repository";
import { ProjectService } from "@/services/project.service";

const memberships = new MembershipRepository();
const projects = new ProjectService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const membership = await memberships.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json(await projects.list(orgId, departmentScopeFor(membership)));
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;
    const membership = await memberships.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const parsed = createProjectSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    if (!isDepartmentInScope(parsed.data.departmentId, departmentScopeFor(membership))) {
      return NextResponse.json({ error: "You can only create projects in your assigned department(s)." }, { status: 403 });
    }
    return NextResponse.json(await projects.create(parsed.data, orgId, user.id), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create project";
    const validationError = message === "A project needs both a start and end date, or neither" || message === "Project end must be after its start";
    return NextResponse.json({ error: message }, { status: validationError ? 400 : 500 });
  }
}
