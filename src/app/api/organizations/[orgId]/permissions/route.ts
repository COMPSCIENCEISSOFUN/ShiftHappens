/**
 * Permissions API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/permissions — List all available permissions
 * 
 * Returns the full list of system permissions grouped by category.
 * Used by the role creation/edit UI to display permission toggles.
 * Requires authentication and Company Admin role.
 */
import { NextRequest, NextResponse } from "next/server";
import { RoleService } from "@/services/role.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const roleService = new RoleService();
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
    if (!membership || !hasPermission(membership, PERMISSIONS.ROLES_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const permissions = await roleService.getAllPermissions();
    return NextResponse.json(permissions);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
