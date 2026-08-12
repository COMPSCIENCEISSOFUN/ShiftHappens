/**
 * Platform FAQ Entry API (Boundary Layer)
 * PATCH  /api/platform/faq/[faqId] — edit, reorder, publish or unpublish
 * DELETE /api/platform/faq/[faqId] — remove
 *
 * Publishing is a field on the edit rather than its own verb: the answer and
 * the decision to show it are usually the same act, and a separate endpoint
 * would let one succeed while the other failed.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { updateFaqSchema } from "@/lib/validations";
import { FaqService } from "@/services/faq.service";

const faq = new FaqService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ faqId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { faqId } = await params;
    const parsed = updateFaqSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(await faq.update(faqId, parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update entry";
    if (message === "FAQ entry not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (
      message.includes("required") ||
      message.includes("characters or fewer") ||
      message.includes("whole number")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("[PATCH /api/platform/faq/[faqId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ faqId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { faqId } = await params;
    await faq.delete(faqId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete entry";
    if (message === "FAQ entry not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error("[DELETE /api/platform/faq/[faqId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
