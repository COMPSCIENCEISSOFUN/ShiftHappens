/**
 * Platform Admin Auth Guard
 * 
 * Validates that the current user is a platform admin.
 * Used by platform-level API routes that operate across all organizations.
 */
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function getPlatformAdmin() {
  const session = await auth();
  if (!session?.user) return null;

  const tokenVersion = Number(
    (session.user as unknown as Record<string, unknown>).sessionVersion ?? -1
  );
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, image: true, isPlatformAdmin: true, sessionVersion: true },
    });
    if (!user?.isPlatformAdmin || user.sessionVersion !== tokenVersion) return null;
    return user;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2022") throw error;
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, image: true, isPlatformAdmin: true },
    });
    return tokenVersion === 0 && user?.isPlatformAdmin ? user : null;
  }
}
