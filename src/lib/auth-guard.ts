/**
 * Auth Guard Utility (Boundary Layer)
 * 
 * Helper functions for protecting API routes.
 * Used by route handlers to verify authentication
 * and organization access before processing requests.
 */
import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { checkOrgActive } from "@/lib/org-guard";
import { prisma } from "@/lib/prisma";

/**
 * Retrieves the authenticated user from the session.
 * Returns null if no valid session exists.
 */
export async function getAuthenticatedUser() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }
  const tokenVersion = Number(
    (session.user as unknown as Record<string, unknown>).sessionVersion ?? -1
  );
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, image: true, isPlatformAdmin: true, sessionVersion: true },
    });
    if (!user || user.sessionVersion !== tokenVersion) return null;
    return user;
  } catch (error) {
    // Keep the app usable while an older database is being migrated. The
    // version check is restored automatically once the column exists.
    if ((error as { code?: string }).code !== "P2022") throw error;
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, image: true, isPlatformAdmin: true },
    });
    return tokenVersion === 0 ? user : null;
  }
}

/** Returns a standardized 401 Unauthorized JSON response */
export function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Returns a standardized 403 response for suspended organizations */
export function orgSuspendedResponse() {
  return NextResponse.json(
    { error: "Organization is suspended" },
    { status: 403 }
  );
}

/**
 * Checks if an organization is active. Returns a 403 response
 * if suspended, or null if the org is active (proceed normally).
 * 
 * Usage in API routes:
 *   const suspended = await checkOrgSuspended(orgId);
 *   if (suspended) return suspended;
 */
export async function checkOrgSuspended(orgId: string) {
  const isActive = await checkOrgActive(orgId);
  if (!isActive) return orgSuspendedResponse();
  return null;
}
