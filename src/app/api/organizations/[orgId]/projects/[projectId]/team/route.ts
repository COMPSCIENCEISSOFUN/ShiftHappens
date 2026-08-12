/**
 * Project Team API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/projects/[projectId]/team — read the team
 * PUT /api/organizations/[orgId]/projects/[projectId]/team — replace the team
 *
 * The team is who may be considered for the project's work items, so it is
 * read by whoever reads the task board and written by whoever edits a task.
 * No permission of its own: a second vocabulary for the same audience is how
 * two answers to one question come to disagree.
 */
import { NextRequest, NextResponse } from "next/server";

import { checkOrgSuspended, getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { requireAnyPermission, requirePermission } from "@/lib/permission-guard";
import { TASK_LIST_READERS } from "@/lib/permissions";
import { setProjectTeamSchema } from "@/lib/validations";
import { ProjectService } from "@/services/project.service";

const projects = new ProjectService();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; projectId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, projectId } = await params;

    const gate = await requireAnyPermission(user.id, orgId, TASK_LIST_READERS);
    if (!gate.ok) return gate.response;

    const project = await projects.get(projectId, orgId);
    if (
      !project ||
      !isDepartmentInScope(project.departmentId, departmentScopeFor(gate.membership))
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(project.projectMembers);
  } catch (error) {
    console.error("Failed to read project team", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; projectId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, projectId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "tasks:update");
    if (!gate.ok) return gate.response;

    const project = await projects.get(projectId, orgId);
    if (
      !project ||
      !isDepartmentInScope(project.departmentId, departmentScopeFor(gate.membership))
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const parsed = setProjectTeamSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(
      await projects.setTeam(projectId, orgId, parsed.data.membershipIds, user.id)
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update project team" },
      { status: 400 }
    );
  }
}
