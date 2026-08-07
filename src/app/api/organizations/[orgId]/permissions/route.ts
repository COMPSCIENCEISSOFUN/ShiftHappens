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
import { requirePermission } from "@/lib/permission-guard";

const roleService = new RoleService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "roles:manage");
    if (!gate.ok) return gate.response;

    // Org-scoped, because the answer depends on this organisation's plan.
    const permissions = await roleService.getAllPermissions(orgId);
    return NextResponse.json(permissions);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}