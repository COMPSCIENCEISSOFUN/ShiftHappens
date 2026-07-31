/**
 * Eligibility Override API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/tasks/[taskId]/eligibility/override
 * 
 * Creates an eligibility override for a blocked staff member.
 * Requires admin/manager role and a documented reason.
 */
import { NextRequest, NextResponse } from "next/server";
import { EligibilityService } from "@/services/eligibility.service";
import { createEligibilityOverrideSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const eligibilityService = new EligibilityService();
const accessService = new AccessService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await accessService.isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createEligibilityOverrideSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const override = await eligibilityService.createOverride(
      taskId,
      parsed.data.membershipId,
      user.id,
      parsed.data.reason,
      parsed.data.ruleOverridden,
      orgId
    );

    return NextResponse.json(override, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Task not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("does not belong to this organization")) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}