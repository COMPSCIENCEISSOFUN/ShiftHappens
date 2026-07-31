/**
 * Members API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/members — List org members
 * 
 * Requires authentication. Company Admin sees all members.
 * Managers see members of their assigned departments (Phase 3).
 * For now, all org members can view the member list.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserManagementService } from "@/services/user-management.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";

const userMgmtService = new UserManagementService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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