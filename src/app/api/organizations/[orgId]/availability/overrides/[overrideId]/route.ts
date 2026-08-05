import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { AvailabilityService } from "@/services/availability.service";
import { createAvailabilityOverrideSchema } from "@/lib/validations";

const memberships = new MembershipRepository();
const availability = new AvailabilityService();

async function ownMembership(orgId: string) {
  const user = await getAuthenticatedUser();
  if (!user) return { user: null, membership: null };
  return { user, membership: await memberships.findByUserAndOrg(user.id, orgId) };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ orgId: string; overrideId: string }> }) {
  try {
    const { orgId, overrideId } = await params;
    const { user, membership } = await ownMembership(orgId);
    if (!user) return unauthorizedResponse();
    if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const parsed = createAvailabilityOverrideSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    const override = await availability.updateOverride(overrideId, membership.id, parsed.data);
    if (!override) return NextResponse.json({ error: "Override not found." }, { status: 404 });
    return NextResponse.json(override);
  } catch {
    return NextResponse.json({ error: "Could not update the override." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ orgId: string; overrideId: string }> }) {
  try {
    const { orgId, overrideId } = await params;
    const { user, membership } = await ownMembership(orgId);
    if (!user) return unauthorizedResponse();
    if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const deleted = await availability.deleteOverride(overrideId, membership.id);
    if (!deleted) return NextResponse.json({ error: "Override not found." }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Could not remove the override." }, { status: 500 });
  }
}
