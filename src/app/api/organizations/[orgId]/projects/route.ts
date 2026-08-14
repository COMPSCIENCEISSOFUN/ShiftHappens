import { NextRequest, NextResponse } from "next/server";
import { checkOrgSuspended, getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { requireAnyPermission, requirePermission } from "@/lib/permission-guard";
import { TASK_LIST_READERS } from "@/lib/permissions";
import { createProjectSchema } from "@/lib/validations";
import { planRefusal } from "@/lib/api-utils";
import { ProjectService } from "@/services/project.service";
import { DepartmentService } from "@/services/department.service";

const projects = new ProjectService();
const departments = new DepartmentService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const gate = await requireAnyPermission(user.id, orgId, TASK_LIST_READERS);
    if (!gate.ok) return gate.response;
    const membership = gate.membership;
    return NextResponse.json(await projects.list(orgId, departmentScopeFor(membership), { membershipId: membership.id, userId: user.id, role: membership.role }));
  } catch (error) {
    console.error("Failed to list projects", error);
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
    const gate = await requirePermission(user.id, orgId, "tasks:create");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;
    const parsed = createProjectSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    let departmentIds = parsed.data.departmentIds ?? (parsed.data.departmentId ? [parsed.data.departmentId] : []);
    const scope = departmentScopeFor(membership);
    if (departmentIds.length === 0) {
      if (membership.role === "company_admin") {
        departmentIds = (await departments.getByOrganization(orgId)).map((department) => department.id);
      }
    }
    if (departmentIds.length === 0) {
      return NextResponse.json({ error: "Select at least one department." }, { status: 400 });
    }
    if (scope !== null && departmentIds.some((departmentId) => !isDepartmentInScope(departmentId, scope))) {
      return NextResponse.json({ error: "You can only create projects in your assigned department(s)." }, { status: 403 });
    }
    return NextResponse.json(await projects.create({ ...parsed.data, departmentIds }, orgId, user.id), { status: 201 });
  } catch (error) {
    /*
     * A plan refusal is not a fault — 403 like every other capped create.
     * Left in the 500 branch it would have been reported as a server error,
     * and the message it carries is the one thing on that path a reader can
     * act on, so it must not arrive dressed as a crash.
     *
     * `planRefusal` answers BOTH kinds: the feature error ("Projects is not
     * available on the Free plan") and the limit error ("projects limit
     * reached (10/10). Upgrade to Enterprise…"). `ProjectService.create` asks
     * for the feature first, so a Free organisation — whose allowance is zero
     * and would otherwise be told (0/0), as though a container were full —
     * gets the one that names the plan.
     */
    const plan = planRefusal(error);
    if (plan) return plan;
    const message = error instanceof Error ? error.message : "Could not create project";
    const validationError = message === "A project needs both a start and end date, or neither" || message === "Project end must be after its start";
    return NextResponse.json({ error: message }, { status: validationError ? 400 : 500 });
  }
}
