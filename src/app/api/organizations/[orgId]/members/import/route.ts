/**
 * Member Batch Import API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/members/import — Bulk create members from spreadsheet
 *
 * Requires authentication, company_admin role, active org, Pro+ subscription.
 * Validates all rows with Zod, then delegates to UserManagementService.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { UserManagementService } from "@/services/user-management.service";
import { SubscriptionService } from "@/services/subscription.service";
import { batchImportSchema } from "@/lib/validations";
import { checkOrgActive } from "@/lib/org-guard";

const userManagementService = new UserManagementService();
const subscriptionService = new SubscriptionService();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "members:invite");
    if (!gate.ok) return gate.response;

    // Block on suspended orgs
    const isActive = await checkOrgActive(orgId);
    if (!isActive) {
      return NextResponse.json(
        { error: "Organization is suspended" },
        { status: 403 }
      );
    }

    // Feature gate — Pro+ only
    const canImport = await subscriptionService.canUseFeature(orgId, "mass_import");
    if (!canImport) {
      return NextResponse.json(
        { error: "Mass import requires a Pro or Enterprise subscription" },
        { status: 403 }
      );
    }

    // Pre-check member limit
    const limitCheck = await subscriptionService.checkResourceLimit(orgId, "members");
    if (!limitCheck.allowed) {
      return NextResponse.json(
        {
          error: `Member limit reached (${limitCheck.current}/${limitCheck.limit}). Upgrade your plan to add more members.`,
        },
        { status: 403 }
      );
    }

    const body = await req.json();
    const parsed = batchImportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Check if import would exceed limit
    if (limitCheck.limit !== null) {
      const totalAfter = limitCheck.current + parsed.data.members.length;
      if (totalAfter > limitCheck.limit) {
        return NextResponse.json(
          {
            error: `Import would exceed member limit. Current: ${limitCheck.current}, importing: ${parsed.data.members.length}, limit: ${limitCheck.limit}.`,
          },
          { status: 403 }
        );
      }
    }

    const result = await userManagementService.batchImportMembers(
      orgId,
      parsed.data.members,
      user.id
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/organizations/[orgId]/members/import]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}