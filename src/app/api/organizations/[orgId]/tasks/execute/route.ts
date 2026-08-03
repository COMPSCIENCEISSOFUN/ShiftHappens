/** Manager conversational task execution. */
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const membershipRepository = new MembershipRepository();

export async function POST(request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepository.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    if (!body || typeof body.text !== "string" || body.text.trim().length < 3) {
      return NextResponse.json({ error: "Describe what needs to be done." }, { status: 400 });
    }

    const { ManagerTaskAutomationService } = await import("@/services/manager-task-automation.service");
    const result = await new ManagerTaskAutomationService().execute(body.text.trim(), orgId, user.id, membership);
    return NextResponse.json(result, { status: result.status === "completed" ? 201 : 200 });
  } catch (error) {
    console.error("[Manager Task Automation Error]", error);
    if (error instanceof Error && error.message.includes("time")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "I could not complete that task request." }, { status: 500 });
  }
}
