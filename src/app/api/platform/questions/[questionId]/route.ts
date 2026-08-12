/**
 * Platform Question API (Boundary Layer)
 * PATCH /api/platform/questions/[questionId] — mark handled, or put it back
 *
 * "Handled" covers both outcomes: answered in the FAQ, and judged not worth an
 * entry. One flag rather than a status, because those are the only two things
 * the admin can actually do and a richer vocabulary would imply a workflow that
 * does not exist.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { handleQuestionSchema } from "@/lib/validations";
import { QuestionService } from "@/services/question.service";

const questions = new QuestionService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ questionId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { questionId } = await params;
    const parsed = handleQuestionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(
      await questions.setHandled(questionId, parsed.data.handled)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update";
    if (message === "Question not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error("[PATCH /api/platform/questions/[questionId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
