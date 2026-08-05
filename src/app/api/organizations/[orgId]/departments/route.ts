/**
 * Departments API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/departments — Create department
 * GET /api/organizations/[orgId]/departments — List departments
 * 
 * Requires authentication. Create requires Company Admin role.
 * List is accessible to all org members.
 */
import { NextRequest, NextResponse } from "next/server";
import { DEPARTMENT_LIST_READERS } from "@/lib/permissions";
import { DepartmentService } from "@/services/department.service";
import { createDepartmentSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission, requireAnyPermission } from "@/lib/permission-guard";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";

const deptService = new DepartmentService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    // Only Company Admin can create departments
    const gate = await requirePermission(user.id, orgId, "departments:create");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = createDepartmentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const dept = await deptService.create(parsed.data, orgId, user.id);
    return NextResponse.json(dept, { status: 201 });
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof Error && error.message === "Department name already exists") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Any org member can view departments
    /*
     * Membership alone was the whole check, so any staff member who typed the
     * URL got this list in full — while the sidebar hid the link. The menu was
     * right; the route was the half that had not been tightened. The readers
     * are the department screen, the task form, work rules and the importer.
     */
    const gate = await requireAnyPermission(user.id, orgId, DEPARTMENT_LIST_READERS);
    if (!gate.ok) return gate.response;

    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
    const depts = await deptService.getByOrganization(orgId, includeArchived);
    return NextResponse.json(depts);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}