/**
 * Bulk Invitations API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/invitations/bulk — Send many invitations
 *
 * The rows arrive already resolved by the import preview, but they are
 * validated again here with the same schema a single invitation uses. The
 * preview is a convenience the client could skip; this is the boundary.
 *
 * Answers 207 when some rows succeeded and others did not, because neither 200
 * nor 400 is true of a partial send and the client has to render both halves.
 *
 * Body: { rows: InviteUserInput[] }
 *
 * Returns:
 * - 200: { sent, failed } — every row sent
 * - 207: { sent, failed } — some sent, some refused
 * - 400: Validation failed
 * - 401: Unauthorized
 * - 403: Lacks members:invite, org suspended, or not on a paying plan
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { UserManagementService } from "@/services/user-management.service";
import { SubscriptionService } from "@/services/subscription.service";
import { inviteUserSchema } from "@/lib/validations";
import { requirePermission } from "@/lib/permission-guard";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";

export const runtime = "nodejs";

const userMgmtService = new UserManagementService();
const subscriptionService = new SubscriptionService();

const bulkInviteSchema = z.object({
  rows: z.array(inviteUserSchema).min(1).max(500),
});

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

    const gate = await requirePermission(user.id, orgId, "members:invite");
    if (!gate.ok) return gate.response;

    const canImport = await subscriptionService.canUseFeature(
      orgId,
      "mass_import"
    );
    if (!canImport) {
      return NextResponse.json(
        { error: "Bulk invite requires a Pro or Enterprise subscription" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parsed = bulkInviteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await userMgmtService.bulkInvite(
      parsed.data.rows,
      orgId,
      user.id
    );

    return NextResponse.json(result, {
      status: result.failed.length > 0 ? 207 : 200,
    });
  } catch (error) {
    console.error("[Bulk Invite Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
