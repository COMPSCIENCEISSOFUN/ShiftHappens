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
import { requirePermission, requireAnyPermission } from "@/lib/permission-guard";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";

const roleService = new RoleService();

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

    const gate = await requirePermission(user.id, orgId, "roles:manage");
    if (!gate.ok) return gate.response;

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

    /*
     * Three screens read this list, for three different reasons: the roles page
     * to edit them, the members page to assign one, and the work-rules page to
     * target a rule at one. Membership alone left every staff member able to
     * enumerate the org's custom roles and the permissions attached to each —
     * which is a map of who can do what, and the roles page rendered it in full
     * to anyone who typed the URL. `roles:manage` alone would have broken the
     * other two screens, so the endpoint names all three.
     */
    const gate = await requireAnyPermission(user.id, orgId, [
      "roles:manage",
      "members:update_role",
      "work_rules:manage",
    ]);
    if (!gate.ok) return gate.response;

    const roles = await roleService.getByOrganization(orgId);
    return NextResponse.json(roles);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}