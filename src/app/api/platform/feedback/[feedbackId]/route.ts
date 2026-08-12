/**
 * Platform Feedback Item API (Boundary Layer)
 * PATCH /api/platform/feedback/[feedbackId] — archive or restore
 *
 * Archiving is housekeeping, not a verdict, and it is invisible to the sender.
 * Restoring exists because the alternative to an undo is a queue people are
 * afraid to tidy.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { archiveFeedbackSchema } from "@/lib/validations";
import { FeedbackService } from "@/services/feedback.service";

const feedback = new FeedbackService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ feedbackId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { feedbackId } = await params;
    const parsed = archiveFeedbackSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await feedback.setArchived(feedbackId, parsed.data.archived);
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update";
    if (message === "Feedback not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error("[PATCH /api/platform/feedback/[feedbackId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
