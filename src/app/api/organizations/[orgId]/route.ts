/**
 * Organization Details API Endpoint (Boundary Layer)
 * GET  /api/organizations/[orgId] — Get organization details
 * PATCH /api/organizations/[orgId] — Update organization details (company_admin only)
 *
 * Requires authentication and active org membership.
 * PATCH requires company_admin role and non-suspended org.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { OrganizationService } from "@/services/organization.service";
import { updateOrganizationSchema } from "@/lib/validations";
import { checkOrgActive } from "@/lib/org-guard";

const accessService = new AccessService();
const orgService = new OrganizationService();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Verify active membership
    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.status !== "active") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const org = await orgService.getOrganization(orgId);
    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    return NextResponse.json(org);
  } catch (error) {
    console.error("[GET /api/organizations/[orgId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Verify company_admin role
    const membership = await accessService.getMembership(user.id, orgId);
    if (
      !membership ||
      membership.status !== "active" ||
      membership.role !== "company_admin"
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Block mutations on suspended orgs
    const isActive = await checkOrgActive(orgId);
    if (!isActive) {
      return NextResponse.json(
        { error: "Organization is suspended" },
        { status: 403 }
      );
    }

    const body = await req.json();
    const parsed = updateOrganizationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const updated = await orgService.updateOrganization(
      orgId,
      parsed.data,
      user.id
    );

    return NextResponse.json(updated);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";

    if (message === "Organization not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message === "Organization name cannot be empty") {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    console.error("[PATCH /api/organizations/[orgId]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}