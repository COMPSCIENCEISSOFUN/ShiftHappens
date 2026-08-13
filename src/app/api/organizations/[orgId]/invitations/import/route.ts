/**
 * Invite Import Preview API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/invitations/import — Resolve spreadsheet rows
 *
 * Reads nothing and writes nothing. It answers "what would these rows mean",
 * so the dialog can show a preview with per-row errors before anybody sends
 * forty invitations.
 *
 * The AI keys live on the server, which is the reason this is an endpoint at
 * all rather than something the dialog works out for itself.
 *
 * Body: { rows: Array<Record<string, string>> }
 *
 * Returns:
 * - 200: { rows, unmappedHeaders, usedAi }
 * - 400: Validation failed
 * - 401: Unauthorized
 * - 403: Lacks members:invite, org suspended, or not on a paying plan
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { InviteImportService } from "@/services/invite-import.service";
import { SubscriptionService } from "@/services/subscription.service";
import { DepartmentRepository } from "@/repositories/department.repository";
import { requirePermission } from "@/lib/permission-guard";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";

export const runtime = "nodejs";

const importService = new InviteImportService();
const subscriptionService = new SubscriptionService();
const departmentRepo = new DepartmentRepository();

/*
 * Bounded on every axis a caller controls. This endpoint forwards its input to
 * a model, so an unbounded body is an unbounded bill as well as an unbounded
 * parse — and 500 rows is already far more than the member limit of any plan.
 */
const importSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.string().max(500)))
    .min(1, "The file has no rows")
    .max(500, "Import at most 500 rows at a time"),
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

    const gate = await requirePermission(user.id, orgId, "members:invite");
    if (!gate.ok) return gate.response;

    // Same gate as the member mass import: this is the same capability applied
    // to invitations, and gating one but not the other would make the paid
    // feature reachable by uploading the same file on a different screen.
    const canImport = await subscriptionService.canUseFeature(
      orgId,
      "mass_import"
    );
    if (!canImport) {
      return NextResponse.json(
        { error: "Bulk invite requires a Pro or Enterprise subscription" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Active only — an archived department is not somewhere a new member can
    // be placed, so matching against one would resolve the row and then fail
    // at assignment for a reason the preview never showed.
    const departments = await departmentRepo.findActiveNames(orgId);
    const result = await importService.resolve(parsed.data.rows, departments);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Invite Import Error]", error);
    return NextResponse.json(
      { error: "Could not read that file" },
      { status: 500 }
    );
  }
}
