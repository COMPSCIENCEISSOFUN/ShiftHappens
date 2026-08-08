/**
 * Platform Single Organization API Endpoint (Boundary Layer)
 * GET   /api/platform/organizations/[orgId] — Get organization details
 * PATCH /api/platform/organizations/[orgId] — Update organization
 *
 * PATCH accepts an optional JSON body:
 *   { subscriptionTier: "free" | "pro" | "enterprise" } → updates tier
 *   No body or empty body → toggles status (active ↔ suspended)
 *
 * Requires platform admin authentication.
 */
import { NextRequest, NextResponse } from "next/server";
import { PlatformService } from "@/services/platform.service";
import { getPlatformAdmin } from "@/lib/platform-guard";

const platformService = new PlatformService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { orgId } = await params;
    const org = await platformService.getOrganizationById(orgId);
    return NextResponse.json(org);
  } catch (error) {
    if (error instanceof Error && error.message === "Organization not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const admin = await getPlatformAdmin();
    if (!admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { orgId } = await params;

    // Parse body — empty body falls through to toggle status
    const body = await request.json().catch(() => ({}));

    // Tier update
    if (body.subscriptionTier) {
      const updated = await platformService.updateOrganizationTier(
        orgId,
        body.subscriptionTier,
        admin.id
      );
      return NextResponse.json(updated);
    }

    // Default: toggle status (backward compatible)
    const updated = await platformService.toggleOrganizationStatus(
      orgId,
      admin.id
    );
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Organization not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.startsWith("Invalid subscription tier")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}