/**
 * Platform Review Queue API (Boundary Layer)
 * GET /api/platform/reviews — reviews awaiting a decision
 *
 * Platform admin only. `?status=` narrows to one state; the default is what is
 * waiting, because that is the only list with work in it.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { ReviewService } from "@/services/review.service";

const reviews = new ReviewService();

export async function GET(request: NextRequest) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const params = request.nextUrl.searchParams;
    const rawPage = Number(params.get("page") ?? 0);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;

    // "all" is spelled by asking for a status the filter does not recognise,
    // which the service treats as no filter at all.
    return NextResponse.json(
      await reviews.getQueue(params.get("status") ?? "pending", page)
    );
  } catch (error) {
    console.error("[GET /api/platform/reviews]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
