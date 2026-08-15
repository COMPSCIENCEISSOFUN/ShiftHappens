/**
 * Platform Admin Auth Guard
 *
 * Validates that the current user is a platform admin.
 * Used by platform-level API routes that operate across all organizations.
 *
 */
import { auth } from "@/lib/auth";
import { PlatformService } from "@/services/platform.service";

const platformService = new PlatformService();

export async function getPlatformAdmin() {
  const session = await auth();
  if (!session?.user?.id) return null;

  // Deliberately NOT reading session.user.isPlatformAdmin — see above.
  const isAdmin = await platformService.isPlatformAdmin(session.user.id);
  if (!isAdmin) return null;

  return session.user;
}
