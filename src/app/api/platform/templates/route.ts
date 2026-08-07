/**
 * Platform Template Management API (Boundary Layer)
 * GET  /api/platform/templates — List all templates (platform admin)
 * POST /api/platform/templates — Create a new template (platform admin)
 *
 * Also serves as public endpoint for active templates when
 * accessed without platform admin auth (GET only, active filter).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { IndustryTemplateService } from "@/services/industry-template.service";
import { prisma } from "@/lib/prisma";

const templateService = new IndustryTemplateService();

export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    // Check if platform admin
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { isPlatformAdmin: true },
    });

    if (dbUser?.isPlatformAdmin) {
      // Platform admin sees all templates with usage counts
      const templates = await templateService.getAllTemplates();
      return NextResponse.json(templates);
    }

    // Regular users see active templates only (for onboarding/settings)
    const templates = await templateService.getActiveTemplates();
    return NextResponse.json(templates);
  } catch (error) {
    console.error("[GET /api/platform/templates]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    // Platform admin only
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { isPlatformAdmin: true },
    });
    if (!dbUser?.isPlatformAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();

    const template = await templateService.createTemplate({
      name: body.name,
      icon: body.icon || "Building",
      description: body.description,
      departments: body.departments || [],
      workRules: body.workRules || [],
      certifications: body.certifications || [],
      isAiGenerated: body.isAiGenerated || false,
    });

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";

    if (
      message.includes("already exists") ||
      message.includes("is required") ||
      message.includes("Maximum")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    console.error("[POST /api/platform/templates]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
