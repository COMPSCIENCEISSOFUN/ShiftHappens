/**
 * Mark All Notifications Read API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/notifications/mark-all-read
 *
 * Clears the unread state for the caller's notifications in THIS organisation
 * only. A user who belongs to two orgs clearing one feed must not silently
 * clear the other.
 */
import { NextRequest, NextResponse } from "next/server";
import { NotificationService } from "@/services/notification.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";

const notificationService = new NotificationService();
const membershipRepo = new MembershipRepository();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await notificationService.markAllAsRead(user.id, orgId);
    return NextResponse.json({
      message: "All notifications marked as read",
      count: result.count,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
