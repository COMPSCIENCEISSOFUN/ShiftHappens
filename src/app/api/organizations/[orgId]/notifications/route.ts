/**
 * Notifications Feed API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/notifications
 *
 * Returns one page of the caller's notifications for this organisation, plus
 * the unfiltered counts the page header renders (unread, today, needs action,
 * and a count per filter pill).
 *
 * Query params: category, unread, search, limit (default 20, max 50), offset.
 *
 * Filtering, searching and counting all happen server-side. Doing any of it in
 * the browser would make the numbers describe only the rows already fetched,
 * so they would silently disagree with the database as the user paginates.
 *
 * Any member of the org may read their own feed — notifications are per-user,
 * so there is no role gate beyond membership.
 */
import { NextRequest, NextResponse } from "next/server";
import { NotificationService } from "@/services/notification.service";
import { notificationFeedQuerySchema } from "@/lib/validations";
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

    const { searchParams } = new URL(request.url);
    const parsed = notificationFeedQuerySchema.safeParse({
      category: searchParams.get("category") ?? undefined,
      unread: searchParams.get("unread") ?? undefined,
      search: searchParams.get("search") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const feed = await notificationService.getFeed(user.id, orgId, {
      category: parsed.data.category,
      unreadOnly: parsed.data.unread,
      search: parsed.data.search,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return NextResponse.json(feed);
  } catch (error) {
    console.error("[Notifications Feed Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
