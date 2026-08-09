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
      /*
       * 403, the same answer `PATCH /members/[userId]` gives for this exact
       * message. The edit path is the one that matters most: it is where
       * somebody holding `roles:manage` could add a permission to the role they
       * are already wearing and hold it on the next request.
       */
      if (
        error.message.startsWith("You cannot grant permissions you do not hold") ||
        error.message === "Not authorized to manage roles"
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message.startsWith("A role called")) {
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
      /*
       * 409: the request is well-formed and the role exists — it is the current
       * state that refuses, and the message names the work rules to retarget.
       *
       * This branch was written on PATCH, where nothing can raise it:
       * `assertNoWorkRulesTargetRole` is called from `delete` alone. So the one
       * refusal it was written for reached the caller as an opaque 500, with
       * the sentence naming the offending rules discarded on the way — the
       * exact outcome the service comment says it exists to prevent.
       */
      if (error.message.startsWith("Cannot delete:")) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}