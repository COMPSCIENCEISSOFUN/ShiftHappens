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
import { AvailabilityService, WINDOW_LENGTH_ERROR } from "@/services/availability.service";
import { setWeeklyAvailabilitySchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const availService = new AvailabilityService();

/**
 * The member's current pattern, for the editor that sets it.
 *
 * Same permission as the PUT below rather than a laxer read gate: a weekly
 * pattern says when somebody is at work, which is not something every colleague
 * needs. Gating read and write together also means the drawer cannot show a
 * field it would then be refused on saving.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;

    const gate = await requirePermission(
      user.id,
      orgId,
      "members:set_contracted_days"
    );
    if (!gate.ok) return gate.response;

    const schedule = await availService.getContractedDaysForUser(
      orgId,
      userId,
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(schedule);
  } catch (error) {
    if (error instanceof Error && error.message === "Member not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

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
      // Thrown by setDayAvailability when a working day has no length. A day
      // that runs PAST MIDNIGHT is legitimate and no longer reaches here.
      if (error.message === WINDOW_LENGTH_ERROR) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
