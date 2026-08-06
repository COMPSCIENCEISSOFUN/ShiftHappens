/**
 * Contracted Days API (Boundary Layer)
 * PUT /api/organizations/[orgId]/members/[userId]/contracted-days
 *
 * Sets the weekly pattern a member is contracted to work.
 *
 * Admin territory, not a manager's. `members:update_seniority` next door is a
 * judgement about running a shift and managers hold it; the days somebody is
 * employed to work is a term of their employment, so the permission is left out
 * of the manager grant and reaches admins through the whole-catalogue rule in
 * `effectivePermissions`.
 *
 * Sibling of PUT /availability, which writes the CALLER's own pattern and now
 * refuses full-time members outright. The two endpoints exist because they
 * answer to different people.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { setWeeklyAvailabilitySchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const availService = new AvailabilityService();

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(
      user.id,
      orgId,
      "members:set_contracted_days"
    );
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = setWeeklyAvailabilitySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await availService.setContractedDaysForUser(
      orgId,
      userId,
      parsed.data.schedule,
      user.id,
      departmentScopeFor(gate.membership)
    );

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Member not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      // Thrown by setDayAvailability when a working day runs backwards.
      if (error.message.includes("End time")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
