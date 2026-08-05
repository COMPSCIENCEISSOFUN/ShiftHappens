/**
 * Recurring Task Generation API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/recurring-tasks/generate
 *
 * Materialises upcoming instances for every recurring series in the org.
 * Safe to run repeatedly — occurrences that already exist are skipped — so
 * this is the endpoint to point a scheduler at (e.g. nightly).
 *
 * Body (optional): { horizonDays?: number }  — how far ahead to generate.
 *
 * Requires admin/manager role.
 *
 * Returns: { seriesProcessed, created, skippedExisting, skippedAtLimit, limitReached }
 * `limitReached` is true when the plan's active-task limit stopped generation.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  RecurringTaskService,
  DEFAULT_HORIZON_DAYS,
} from "@/services/recurring-task.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { z } from "zod";

const recurringTaskService = new RecurringTaskService();

const bodySchema = z.object({
  horizonDays: z.number().int().min(1).max(365).optional(),
});

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

    const gate = await requirePermission(user.id, orgId, "tasks:create");
    if (!gate.ok) return gate.response;

    // Body is optional — an empty POST uses the default horizon.
    let horizonDays = DEFAULT_HORIZON_DAYS;
    try {
      const body = await request.json();
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Validation failed", details: parsed.error.flatten() },
          { status: 400 }
        );
      }
      horizonDays = parsed.data.horizonDays ?? DEFAULT_HORIZON_DAYS;
    } catch {
      // No/invalid JSON body — fall back to the default horizon.
    }

    const result = await recurringTaskService.generateForOrganization(
      orgId,
      horizonDays,
      user.id,
      departmentScopeFor(gate.membership)
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Recurring Generate Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
