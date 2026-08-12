/**
 * Platform Feedback Queue API (Boundary Layer)
 * GET /api/platform/feedback — every tenant's feedback, newest first
 *
 * Platform admin only. Deliberately cross-tenant: this is the one read in the
 * system whose question has no organisation in it. `?area=` narrows to one
 * area, `?archived=1` includes the ones already cleared, `?page=` pages.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { FeedbackService } from "@/services/feedback.service";

const feedback = new FeedbackService();

export async function GET(request: NextRequest) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const params = request.nextUrl.searchParams;
    // Anything unusable becomes 0 here; the service clamps the upper end
    // against the real count, because only it knows what that is.
    const rawPage = Number(params.get("page") ?? 0);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;

    const [queue, areas] = await Promise.all([
      feedback.getQueue(
        {
          area: params.get("area") ?? undefined,
          includeArchived: params.get("archived") === "1",
        },
        page
      ),
      feedback.getAreaCounts(),
    ]);

    return NextResponse.json({ ...queue, areas });
  } catch (error) {
    console.error("[GET /api/platform/feedback]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
