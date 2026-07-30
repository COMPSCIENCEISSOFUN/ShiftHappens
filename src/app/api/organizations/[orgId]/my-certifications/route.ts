/**
 * My Certifications API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/my-certifications — the caller's own certifications
 *
 * The org-wide GET /certifications is gated to admin/manager, since it exposes
 * every member's records. A staff member still needs to see their own — to know
 * what was verified, what was rejected and why, and what is about to lapse — so
 * this mirrors the my-tasks convention: membership is the only requirement, and
 * the query is scoped to that membership rather than the organisation.
 *
 * BCE: Route (Boundary) → CertificationService (Control) → Repository (Entity)
 */
import { NextRequest, NextResponse } from "next/server";
import { CertificationService } from "@/services/certification.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";

const certService = new CertificationService();
const membershipRepo = new MembershipRepository();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const certifications = await certService.getByMembership(membership.id);
    return NextResponse.json(certifications);
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
