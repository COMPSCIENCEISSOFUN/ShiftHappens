/**
 * Platform Questions API (Boundary Layer)
 * GET /api/platform/questions — what people have asked, oldest first
 *
 * Platform admin only. `?handled=1` includes the ones already dealt with,
 * `?page=` pages.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { QuestionService } from "@/services/question.service";

const questions = new QuestionService();

export async function GET(request: NextRequest) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const params = request.nextUrl.searchParams;
    const rawPage = Number(params.get("page") ?? 0);
    // The service clamps the upper end against the real count.
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;

    return NextResponse.json(
      await questions.getList(params.get("handled") === "1", page)
    );
  } catch (error) {
    console.error("[GET /api/platform/questions]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
