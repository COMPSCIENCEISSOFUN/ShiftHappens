import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { validationErrorResponse } from "@/lib/api-utils";
import { updateCertificationDefinitionSchema } from "@/lib/validations";
import { MembershipRepository } from "@/repositories/membership.repository";
import { CertificationDefinitionService } from "@/services/certification-definition.service";

const membershipRepository = new MembershipRepository();
const service = new CertificationDefinitionService();

async function activeMembership(userId: string, organizationId: string) {
  return membershipRepository.findByUserAndOrg(userId, organizationId);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; definitionId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId, definitionId } = await params;
    const membership = await activeMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const definition = await service.getById(definitionId, orgId);
    if (
      !definition ||
      (!definition.isActive && membership.role !== "company_admin")
    ) {
      return NextResponse.json(
        { error: "Certification definition not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(definition);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function authorizeAdmin(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) return { error: unauthorizedResponse() };
  const suspended = await checkOrgSuspended(organizationId);
  if (suspended) return { error: suspended };
  const membership = await activeMembership(user.id, organizationId);
  if (!membership || membership.role !== "company_admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; definitionId: string }> }
) {
  try {
    const { orgId, definitionId } = await params;
    const auth = await authorizeAdmin(orgId);
    if (auth.error) return auth.error;
    const parsed = updateCertificationDefinitionSchema.safeParse(
      await request.json()
    );
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const updated = await service.update(
      definitionId,
      orgId,
      parsed.data,
      auth.user!.id
    );
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Certification definition not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message === "Certification definition name already exists") {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error.message === "Invalid department assignment") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; definitionId: string }> }
) {
  try {
    const { orgId, definitionId } = await params;
    const auth = await authorizeAdmin(orgId);
    if (auth.error) return auth.error;
    await service.delete(definitionId, orgId, auth.user!.id);
    return NextResponse.json({ message: "Certification definition deleted" });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Certification definition not found"
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
