/**
 * Platform Template Management API (Boundary Layer)
 * GET  /api/platform/templates — every template, with usage counts
 * POST /api/platform/templates — create a template
 *
 * Platform admin only, both verbs.
 *
 * ## What changed
 *
 * GET used to branch on `isPlatformAdmin` and never deny — an admin got every
 * template with usage counts, everyone else got the active ones. It was
 * recorded as a KNOWN GAP in the route manifest, because a path under
 * `/api/platform/` that any authenticated user may call is a contradiction: the
 * prefix is the only thing telling the next person who the audience is.
 *
 * The member-facing half moved to `GET /api/industry-templates`, which is
 * honest about serving anyone signed in. What stays here is the part that
 * genuinely belongs to the console: retired templates, and usage counts — a
 * cross-tenant aggregate of how many organisations chose each template, which
 * nothing outside the platform console should read.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { IndustryTemplateService } from "@/services/industry-template.service";
import { PlatformService } from "@/services/platform.service";

const templateService = new IndustryTemplateService();
const platformService = new PlatformService();

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    // Denies, rather than branching. The active-template list non-admins used
    // to fall through to lives at `GET /api/industry-templates` now.
    if (!(await platformService.isPlatformAdmin(user.id))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const templates = await templateService.getAllTemplates();
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
    if (!(await platformService.isPlatformAdmin(user.id))) {
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
      message.includes("Maximum") ||
      // The sibling PATCH on [templateId] already matches "Invalid", so the same
      // validation error returned 400 on edit and 500 on create.
      message.includes("Invalid")
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