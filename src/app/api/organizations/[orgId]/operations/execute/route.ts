import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
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
    const body = await request.json();
    if (typeof body.text !== "string" || body.text.trim().length < 2 || body.text.length > 500) {
      return NextResponse.json({ error: "Enter a request between 2 and 500 characters." }, { status: 400 });
    }
    const result = await assistant.execute({ text: body.text, organizationId: orgId, userId: user.id, membership });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Operations Assistant Error]", error);
    return NextResponse.json({ error: "I could not complete that operations request." }, { status: 500 });
  }
}
