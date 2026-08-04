/**
 * Member Seniority API (Boundary Layer)
 * PATCH /api/organizations/[orgId]/members/[userId]/seniority
 *
 * Pins a member's seniority level, or clears the pin so it derives again from
 * completed shifts.
 *
 * Manager or admin, not admin-only like the role endpoint next door. Seniority
 * is a rostering judgement about who can be left to run a shift, which is the
 * manager's job — and a manager blocked by a composition rule they cannot
 * resolve will route around it by deleting the rule.
 */
import { NextRequest, NextResponse } from "next/server";
import { SeniorityService } from "@/services/seniority.service";
import { seniorityOverrideSchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const seniorityService = new SeniorityService();
const accessService = new AccessService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = seniorityOverrideSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await seniorityService.setOverrideForUser(
      orgId,
      userId,
      parsed.data.seniorityOverride,
      user.id
    );

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Member not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message === "Invalid seniority level") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
