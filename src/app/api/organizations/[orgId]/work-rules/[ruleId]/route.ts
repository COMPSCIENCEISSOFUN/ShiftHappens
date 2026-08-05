/**
 * Individual Work Rule API Endpoint (Boundary Layer)
 * PATCH  /api/organizations/[orgId]/work-rules/[ruleId] — update
 * DELETE /api/organizations/[orgId]/work-rules/[ruleId] — delete
 *
 * Requires company_admin role.
 * Rate limit tier: relaxed (100 req/min)
 */
import { NextRequest, NextResponse } from "next/server";
import { WorkRuleService } from "@/services/work-rule.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { updateWorkRuleSchema } from "@/lib/validations";
import { checkOrgActive } from "@/lib/org-guard";

const workRuleService = new WorkRuleService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; ruleId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, ruleId } = await params;

    const isActive = await checkOrgActive(orgId);
    if (!isActive) {
      return NextResponse.json(
        { error: "Organization is suspended" },
        { status: 403 }
      );
    }

    const gate = await requirePermission(user.id, orgId, "work_rules:manage");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = updateWorkRuleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid input" },
        { status: 400 }
      );
    }

    const updated = await workRuleService.update(
      ruleId,
      orgId,
      parsed.data,
      user.id
    );
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";

    if (message === "Work rule not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    // Foreign targets read as missing — see WorkRuleService.assertTargetsOwned.
    if (message === "Department not found" || message === "Role not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.includes("already exists")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.includes("required") || message.includes("Unknown rule type")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    console.error("[Work Rules PATCH Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; ruleId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, ruleId } = await params;

    const isActive = await checkOrgActive(orgId);
    if (!isActive) {
      return NextResponse.json(
        { error: "Organization is suspended" },
        { status: 403 }
      );
    }

    const gate = await requirePermission(user.id, orgId, "work_rules:manage");
    if (!gate.ok) return gate.response;

    await workRuleService.delete(ruleId, orgId, user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";

    if (message === "Work rule not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    console.error("[Work Rules DELETE Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}