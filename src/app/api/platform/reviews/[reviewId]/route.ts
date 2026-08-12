/**
 * Platform Review Decision API (Boundary Layer)
 * PATCH /api/platform/reviews/[reviewId] — approve or reject
 *
 * Only those two. Returning a review to "pending" is not a decision anybody
 * makes — an edit by its author does that — and offering it here would let a
 * moderator undo an approval in a way the author never sees.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { moderateReviewSchema } from "@/lib/validations";
import { ReviewService } from "@/services/review.service";

const reviews = new ReviewService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { reviewId } = await params;
    const parsed = moderateReviewSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(
      await reviews.setStatus(reviewId, parsed.data.status)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update";
    if (message === "Review not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.startsWith("A review can only be")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("[PATCH /api/platform/reviews/[reviewId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
