import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { validationErrorResponse } from "@/lib/api-utils";
import { createCertificationDefinitionSchema } from "@/lib/validations";
import { MembershipRepository } from "@/repositories/membership.repository";
import { CertificationDefinitionService } from "@/services/certification-definition.service";

const membershipRepository = new MembershipRepository();
const service = new CertificationDefinitionService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const membership = await membershipRepository.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const canManage = membership.role === "company_admin";
    const includeInactive =
      canManage && request.nextUrl.searchParams.get("includeInactive") === "true";
    const definitions = await service.getByOrganization(orgId, includeInactive);
    return NextResponse.json({ definitions, canManage });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
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
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepository.findByUserAndOrg(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = createCertificationDefinitionSchema.safeParse(
      await request.json()
    );
    if (!parsed.success) return validationErrorResponse(parsed.error);

    const definition = await service.create(orgId, parsed.data, user.id);
    return NextResponse.json(definition, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Certification definition name already exists"
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message === "Invalid department assignment") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
