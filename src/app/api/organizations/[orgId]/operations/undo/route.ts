import { NextRequest, NextResponse } from "next/server";
import { checkOrgSuspended, getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { OperationsAssistantService } from "@/services/operations-assistant.service";

const membershipRepo = new MembershipRepository();
const assistant = new OperationsAssistantService();

export async function POST(request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await request.json();
    if (typeof body?.operationId !== "string" || body.operationId.length > 100) {
      return NextResponse.json({ error: "Invalid undo request." }, { status: 400 });
    }
    const result = await assistant.undo({ operationId: body.operationId, organizationId: orgId, userId: user.id, membership });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not undo that operation." }, { status: 400 });
  }
}
