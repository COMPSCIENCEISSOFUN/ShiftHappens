/**
 * Unread Notification Count API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/notifications/unread-count
 *
 * Feeds the sidebar badge and the bell. Polled every 30 seconds by every
 * signed-in client, so it stays a single indexed COUNT and nothing more.
 */
import { NextRequest, NextResponse } from "next/server";
import { NotificationService } from "@/services/notification.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";

const notificationService = new NotificationService();
const membershipRepo = new MembershipRepository();

export async function GET(
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

    const count = await notificationService.getUnreadCount(user.id, orgId);
    return NextResponse.json({ count });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
