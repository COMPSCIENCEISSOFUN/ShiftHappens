/**
 * Industry Templates — the member-facing read (Boundary Layer).
 * GET /api/industry-templates — the ACTIVE templates, for any signed-in user.
 */
import { NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { IndustryTemplateService } from "@/services/industry-template.service";

const templateService = new IndustryTemplateService();

export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const templates = await templateService.getActiveTemplates();
    return NextResponse.json(templates);
  } catch (error) {
    console.error("[GET /api/industry-templates]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
