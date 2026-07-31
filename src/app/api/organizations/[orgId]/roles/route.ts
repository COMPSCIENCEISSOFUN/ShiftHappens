/**
 * Roles API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/roles — Create custom role
 * GET /api/organizations/[orgId]/roles — List org roles
 * 
 * Requires authentication and Company Admin role.
 */
import { NextRequest, NextResponse } from "next/server";
import { RoleService } from "@/services/role.service";
import { createRoleSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";

const roleService = new RoleService();
const accessService = new AccessService();

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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createRoleSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const role = await roleService.create(parsed.data, orgId, user.id);
    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof Error && error.message === "Role name already exists") {
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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const roles = await roleService.getByOrganization(orgId);
    return NextResponse.json(roles);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}