/**
 * Certification Types API Endpoint (Boundary Layer)
 * GET  /api/organizations/[orgId]/certification-types — the organisation's list
 * POST /api/organizations/[orgId]/certification-types — add a name to it
 *
 * ## Why GET needs only membership
 *
 * Three screens read this list and they answer to different people. A manager
 * picks from it when saying what a shift requires; a STAFF MEMBER sees it as
 * suggestions when recording a certificate of their own. Gating the read on
 * `certifications:review` would have left the member's own screen unable to
 * show them the very list they are meant to pick from, which is the half of the
 * feature that stops the two vocabularies drifting apart.
 *
 * There is nothing sensitive in it. It is a list of certificate names an
 * organisation recognises, and every active member of that organisation is
 * expected to hold some of them.
 *
 * ## Why POST reuses `certifications:review`
 *
 * The people who verify a member's certificate are the people who should decide
 * what the organisation recognises — it is the same judgement, made at the same
 * desk, and the review screen is where an unfamiliar name first appears.
 *
 * A new permission was the alternative and was rejected: the catalogue is
 * seeded from `src/lib/permissions.ts` by `prisma db seed` rather than by a
 * migration, so adding one means a seed run against every database including
 * test, for a distinction nobody asked for.
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
