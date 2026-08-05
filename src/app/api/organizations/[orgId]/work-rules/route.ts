/**
 * Work Rules API Endpoint (Boundary Layer)
 * GET  /api/organizations/[orgId]/work-rules — list all rules
 * POST /api/organizations/[orgId]/work-rules — create a rule
 *
 * Requires company_admin role.
 * Rate limit tier: relaxed (100 req/min)
 */
import { NextRequest, NextResponse } from "next/server";
import { WorkRuleService } from "@/services/work-rule.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { createWorkRuleSchema } from "@/lib/validations";
import { checkOrgActive } from "@/lib/org-guard";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";

const workRuleService = new WorkRuleService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "work_rules:manage");
    if (!gate.ok) return gate.response;

    const rules = await workRuleService.getByOrganization(orgId);
    return NextResponse.json(rules);
  } catch (error) {
    console.error("[Work Rules GET Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
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
    const parsed = createWorkRuleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid input" },
        { status: 400 }
      );
    }

    const rule = await workRuleService.create(parsed.data, orgId, user.id);
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Internal server error";

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

    console.error("[Work Rules POST Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}