/**
 * Department Members API (Boundary Layer)
 * GET /api/organizations/[orgId]/departments/[deptId]/members
 *
 * Who works in one department. Read-only by design: department assignment is
 * written from the member drawer, and a second writer for the same relationship
 * is how two screens come to disagree about it.
 *
 * Its own route rather than a flag on `departments/[deptId]`, which is admin
 * only. Seeing who is in a department is a manager's question — the same
 * audience that may already read the department list — so it carries the same
 * permission and the same scope.
 *
 * A department belonging to another organisation and one outside the caller's
 * scope both answer 404. One answer for both, or the id becomes a way to
 * discover which departments exist elsewhere.
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { requireAnyPermission } from "@/lib/permission-guard";
import { DEPARTMENT_LIST_READERS } from "@/lib/permissions";
import { DepartmentService } from "@/services/department.service";

const departments = new DepartmentService();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; deptId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, deptId } = await params;

    const gate = await requireAnyPermission(user.id, orgId, DEPARTMENT_LIST_READERS);
    if (!gate.ok) return gate.response;

    const result = await departments.getMembers(
      deptId,
      orgId,
      departmentScopeFor(gate.membership)
    );
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/organizations/[orgId]/departments/[deptId]/members]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
