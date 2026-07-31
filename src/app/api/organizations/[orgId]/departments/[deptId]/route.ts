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
import { AccessService } from "@/services/access.service";

const deptService = new DepartmentService();
const accessService = new AccessService();

/** Shared auth + admin guard for all handlers */
async function authorizeAdmin(orgId: string) {
  const user = await getAuthenticatedUser();
  if (!user) return { error: unauthorizedResponse() };

  const suspended = await checkOrgSuspended(orgId);
  if (suspended) return { error: suspended };

  const membership = await accessService.getMembership(user.id, orgId);
  if (!membership || membership.role !== "company_admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    const auth = await authorizeAdmin(orgId);
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
    const auth = await authorizeAdmin(orgId);
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
