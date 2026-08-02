/**
 * Departments API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/departments — Create department
 * GET /api/organizations/[orgId]/departments — List departments
 * 
 * Requires authentication. Create requires Company Admin role.
 * List is accessible to all org members.
 */
import { NextRequest, NextResponse } from "next/server";
import { DepartmentService } from "@/services/department.service";
import { createDepartmentSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const deptService = new DepartmentService();
const membershipRepo = new MembershipRepository();

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
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.DEPARTMENTS_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.DEPARTMENTS_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
    const depts = await deptService.getByOrganization(orgId, includeArchived);
    return NextResponse.json(depts);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
