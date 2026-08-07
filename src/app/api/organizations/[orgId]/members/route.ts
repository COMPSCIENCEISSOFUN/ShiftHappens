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
import { MembershipRepository } from "@/repositories/membership.repository";
import { departmentScopeFor } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const userMgmtService = new UserManagementService();
const membershipRepo = new MembershipRepository();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.MEMBERS_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Managers see only members in their department(s); admins see everyone.
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 100);
    const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);
    const { members, total } = await userMgmtService.getOrgMembersPage(
      orgId,
      departmentScopeFor(membership),
      limit,
      offset
    );
    return NextResponse.json(members, {
      headers: {
        "X-Total-Count": String(total),
        "X-Has-More": String(offset + members.length < total),
      },
    });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
