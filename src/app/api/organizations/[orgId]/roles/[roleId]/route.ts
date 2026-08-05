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
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const roleService = new RoleService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; roleId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, roleId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
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

    const gate = await requirePermission(user.id, orgId, "roles:manage");
    if (!gate.ok) return gate.response;

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
      // 409: the request is well-formed and the role exists — it is the
      // current state that refuses, and the message names the rules to fix.
      if (error.message.startsWith("Cannot delete:")) {
        return NextResponse.json({ error: error.message }, { status: 409 });
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

    const gate = await requirePermission(user.id, orgId, "roles:manage");
    if (!gate.ok) return gate.response;

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