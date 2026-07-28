/**
 * Mark Notification Read API Endpoint (Boundary Layer)
 * PATCH /api/organizations/[orgId]/notifications/[id]/read
 *
 * Marks one notification as read. The service verifies both ownership and
 * organisation, so a notification belonging to another user — or to another
 * org this user also belongs to — cannot be touched from here.
 */
import { NextRequest, NextResponse } from "next/server";
import { NotificationService } from "@/services/notification.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";

const notificationService = new NotificationService();
const membershipRepo = new MembershipRepository();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; id: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, id } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await notificationService.markAsRead(id, user.id, orgId);
    return NextResponse.json({ message: "Notification marked as read" });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Notification not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message === "Not authorized") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
