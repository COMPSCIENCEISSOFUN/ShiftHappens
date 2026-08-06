/**
 * Single Member API Endpoint (Boundary Layer)
 * PATCH /api/organizations/[orgId]/members/[userId] — Update member role
 * POST /api/organizations/[orgId]/members/[userId]/toggle-status — Toggle active/inactive
 * 
 * Requires authentication and Company Admin role.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserManagementService } from "@/services/user-management.service";
import { updateUserRoleSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const userMgmtService = new UserManagementService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "members:update_role");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = updateUserRoleSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await userMgmtService.updateMemberRole(
      userId,
      orgId,
      parsed.data,
      user.id,
      departmentScopeFor(gate.membership)
    );

    // Handle custom role assignment if provided (separate from system role update)
    if (parsed.data.customRoleId !== undefined) {
      await userMgmtService.assignCustomRole(
        userId,
        orgId,
        parsed.data.customRoleId,
        user.id
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Membership not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Cannot demote")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      /*
       * 403, not 400. These are authorisation refusals — the request was
       * well-formed and the caller simply may not make it — and a 400 would
       * read as "fix your input" for something no input can fix.
       */
      if (
        error.message === "You cannot change your own role" ||
        error.message === "You cannot grant a role above your own" ||
        error.message === "You cannot change the role of a member above your own" ||
        error.message === "Not authorized to change roles" ||
        error.message.startsWith("You cannot grant permissions you do not hold")
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message === "Company Admins cannot be assigned custom roles") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error.message === "Custom role not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message === "Cannot assign system roles as custom roles") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}