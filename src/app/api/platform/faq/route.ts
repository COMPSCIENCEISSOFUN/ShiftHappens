/**
 * Platform FAQ API (Boundary Layer)
 * GET  /api/platform/faq — every entry, drafts included
 * POST /api/platform/faq — create an entry, unpublished
 *
 * Platform admin only. There is no public counterpart: the landing page reads
 * published entries on the server as it renders, so this content reaches
 * visitors without an endpoint of its own to defend.
 */
import { NextRequest, NextResponse } from "next/server";

import { getPlatformAdmin } from "@/lib/platform-guard";
import { createFaqSchema } from "@/lib/validations";
import { FaqService } from "@/services/faq.service";

const faq = new FaqService();

export async function GET() {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json(await faq.getAll());
  } catch (error) {
    console.error("[GET /api/platform/faq]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const parsed = createFaqSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(await faq.create(parsed.data), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create entry";
    if (message.includes("required") || message.includes("characters or fewer")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("[POST /api/platform/faq]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
