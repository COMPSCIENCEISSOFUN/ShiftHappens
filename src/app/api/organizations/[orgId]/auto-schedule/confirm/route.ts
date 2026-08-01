/**
 * Auto-Schedule Confirm API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/auto-schedule/confirm
 *
 * Confirms a draft schedule by creating all assignments in batch.
 * Body: { assignments: [{ taskId, membershipId }] }
 * All display, eligibility, and authorization facts are resolved server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { confirmAutoScheduleSchema } from "@/lib/validations";
import { departmentScopeFor } from "@/lib/department-scope";

const autoScheduleService = new AutoScheduleService();
const membershipRepo = new MembershipRepository();

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

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = confirmAutoScheduleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await autoScheduleService.confirmSchedule(
      orgId,
      parsed.data.assignments,
      user.id,
      departmentScopeFor(membership)
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Auto-Schedule Confirm Error]", error);
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (error instanceof Error) {
      if (error.message === "Task not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (
        error.message.includes("Schedule contains") ||
        error.message.includes("cannot be assigned") ||
        error.message.includes("headcount") ||
        error.message.includes("already has an assignment") ||
        error.message.includes("Duplicate")
      ) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
