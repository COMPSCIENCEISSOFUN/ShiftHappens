/**
 * Single Role API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/roles/[roleId] — Get role details
 * PATCH /api/organizations/[orgId]/roles/[roleId] — Update role
 * DELETE /api/organizations/[orgId]/roles/[roleId] — Delete role
 * 
 * Requires authentication and Company Admin role.
 * System roles cannot be modified or deleted.
 */
import { NextRequest, NextResponse } from "next/server";
import { RoleService } from "@/services/role.service";
import { updateRoleSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const roleService = new RoleService();
const membershipRepo = new MembershipRepository();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; roleId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, roleId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.ROLES_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const role = await roleService.getById(roleId, orgId);
    if (!role) {
      return NextResponse.json({ error: "Role not found" }, { status: 404 });
    }

    return NextResponse.json(role);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; roleId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, roleId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.ROLES_UPDATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateRoleSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await roleService.update(roleId, orgId, parsed.data, user.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Cannot modify system roles") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message === "Role not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; roleId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, roleId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.ROLES_DELETE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await roleService.delete(roleId, orgId, user.id);
    return NextResponse.json({ message: "Role deleted" });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Cannot delete system roles") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message === "Role not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
