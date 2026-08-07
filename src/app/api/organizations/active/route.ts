import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return unauthorizedResponse();
  const body = await request.json().catch(() => null);
  if (typeof body?.organizationId !== "string" || body.organizationId.length > 100) {
    return NextResponse.json({ error: "Invalid organization" }, { status: 400 });
  }
  const membership = await prisma.membership.findFirst({
    where: {
      userId: user.id,
      organizationId: body.organizationId,
      status: "active",
      organization: { status: "active" },
    },
    select: { id: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const response = NextResponse.json({ organizationId: body.organizationId });
  response.cookies.set("activeOrganizationId", body.organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
