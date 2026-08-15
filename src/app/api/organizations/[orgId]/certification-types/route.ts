/**
 * Certification Types API Endpoint (Boundary Layer)
 * GET  /api/organizations/[orgId]/certification-types — the organisation's list
 * POST /api/organizations/[orgId]/certification-types — add a name to it
 */
import { NextRequest, NextResponse } from "next/server";
import { CertificationTypeService } from "@/services/certification-type.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const typeService = new CertificationTypeService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json(await typeService.list(orgId));
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "certifications:review");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name : "";

    const type = await typeService.create(orgId, name, user.id);
    return NextResponse.json(type, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      // 400: an empty name is a malformed request, and the reader fixes it by
      // typing something.
      if (error.message === "A certificate name is required") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      // 409: the request is well formed and the current state refuses it.
      if (error.message.endsWith("is already on the list")) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
