/**
 * Member Upcoming Commitments API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/members/[userId]/upcoming-commitments
 *
 * The shifts a member is still expected to work. Read by the deactivation
 * confirmation so an admin can see what they are about to leave short before
 * deciding, rather than finding out from the notifications afterwards.
 *
 * Gated on `members:deactivate` rather than on reading members: this answers
 * "what does deactivating this person cost", and it is only ever asked by
 * somebody about to do it.
 *
 * Returns:
 * - 200: { commitments: [{ taskId, taskTitle, scheduledStart }] }
 * - 401: Unauthorized
 * - 403: Lacks the permission
 * - 404: No such member in this organisation
 */
import { NextRequest, NextResponse } from "next/server";
import { UserManagementService } from "@/services/user-management.service";
import { requirePermission } from "@/lib/permission-guard";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";

const userMgmtService = new UserManagementService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;

    const gate = await requirePermission(user.id, orgId, "members:deactivate");
    if (!gate.ok) return gate.response;

    const commitments = await userMgmtService.getUpcomingCommitments(
      userId,
      orgId
    );

    // Only what the confirmation renders. The assignment ids and department
    // ids the service carries are for the release path, not for a dialog.
    return NextResponse.json({
      commitments: commitments.map((c) => ({
        taskId: c.taskId,
        taskTitle: c.taskTitle,
        scheduledStart: c.scheduledStart,
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Membership not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[Upcoming Commitments Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
