/**
 * Members API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/members — List org members
 * 
 * Requires authentication. Company Admin sees all members.
 * Managers see members of their assigned departments (Phase 3).
 * For now, all org members can view the member list.
 */
import { NextRequest, NextResponse } from "next/server";
import { MEMBER_LIST_READERS } from "@/lib/permissions";
import { requireAnyPermission } from "@/lib/permission-guard";
import { UserManagementService } from "@/services/user-management.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const userMgmtService = new UserManagementService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    /*
     * Membership alone was the whole check, so any staff member who typed the
     * URL got this list in full — while the sidebar hid the link. The menu was
     * right; the route was the half that had not been tightened. The readers
     * are the member directory, the assign panel and the certification queue.
     */
    const gate = await requireAnyPermission(user.id, orgId, MEMBER_LIST_READERS);
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Managers see only members in their department(s); admins see everyone.
    const members = await userMgmtService.getOrgMembers(
      orgId,
      departmentScopeFor(membership)
    );
    return NextResponse.json(members);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}