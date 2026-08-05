/**
 * Single Department API Endpoint (Boundary Layer)
 *
 * GET    /api/organizations/[orgId]/departments/[deptId]?impact=true — Impact summary
 * PATCH  /api/organizations/[orgId]/departments/[deptId] — Update / archive / unarchive
 * DELETE /api/organizations/[orgId]/departments/[deptId] — Permanent delete (archived only)
 *
 * Requires authentication and Company Admin role.
 *
 * PATCH actions:
 *  - { action: "archive" }   — soft-delete (set archivedAt)
 *  - { action: "unarchive" } — restore from archive
 *  - { name?, description?, color? } — field update (default)
 *
 * DELETE is gated: department must be archived first.
 */
import { NextRequest, NextResponse } from "next/server";
import { DepartmentService } from "@/services/department.service";
import { updateDepartmentSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const deptService = new DepartmentService();

/** Shared auth + admin guard for all handlers */
/**
 * Shared session + suspension + permission gate.
 *
 * Takes the permission rather than assuming one. It was hard-coded to
 * `departments:update` and shared by PATCH *and* DELETE, so `departments:delete`
 * could be ticked in the picker and was never consulted, while
 * `departments:update` silently carried the power to delete a department and
 * everything filed under it.
 */
async function authorize(orgId: string, permission: string) {
  const user = await getAuthenticatedUser();
  if (!user) return { error: unauthorizedResponse() };

  const suspended = await checkOrgSuspended(orgId);
  if (suspended) return { error: suspended };

  const gate = await requirePermission(user.id, orgId, permission);
  if (!gate.ok) return { error: gate.response };

  return { user };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; deptId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, deptId } = await params;

    /*
     * `departments:update`, not `departments:read`.
     *
     * This endpoint is the admin edit surface — it returns the impact summary
     * a destructive action is confirmed against. The member-facing list is
     * `GET /departments`, which is what `departments:read` covers.
     */
    const gate = await requirePermission(user.id, orgId, "departments:update");
    if (!gate.ok) return gate.response;

    const isImpact = request.nextUrl.searchParams.get("impact") === "true";

    if (isImpact) {
      const summary = await deptService.getImpactSummary(deptId, orgId);
      return NextResponse.json(summary);
    }

    const dept = await deptService.getById(deptId, orgId);
    return NextResponse.json(dept);
  } catch (error) {
    // getById/getImpactSummary now throw rather than returning null, because a
    // department belonging to another organisation must be indistinguishable
    // from one that does not exist.
    if (error instanceof Error && error.message === "Department not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; deptId: string }> }
) {
  try {
    const { orgId, deptId } = await params;
    const auth = await authorize(orgId, "departments:update");
    if (auth.error) return auth.error;

    const body = await request.json();

    // ── Archive action ──
    if (body.action === "archive") {
      const archived = await deptService.archive(deptId, orgId, auth.user!.id);
      return NextResponse.json(archived);
    }

    // ── Unarchive action ──
    if (body.action === "unarchive") {
      const unarchived = await deptService.unarchive(deptId, orgId, auth.user!.id);
      return NextResponse.json(unarchived);
    }

    // ── Default: field update ──
    const parsed = updateDepartmentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await deptService.update(deptId, orgId, parsed.data, auth.user!.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Department name already exists") {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error.message === "Department not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message === "Department is already archived" ||
          error.message === "Department is not archived") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; deptId: string }> }
) {
  try {
    const { orgId, deptId } = await params;
    const auth = await authorize(orgId, "departments:delete");
    if (auth.error) return auth.error;

    await deptService.delete(deptId, orgId, auth.user!.id);
    return NextResponse.json({ message: "Department permanently deleted" });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Department not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("must be archived")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error.message.includes("Cannot delete")) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
