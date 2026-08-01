/**
 * Platform Admin Auth Guard
 *
 * Validates that the current user is a platform admin.
 * Used by platform-level API routes that operate across all organizations.
 *
 * ## Why this reads the database rather than the session
 *
 * `isPlatformAdmin` is written into the JWT once, at sign-in, and never
 * revalidated. Sessions use the JWT strategy with NextAuth's 30-day default, so
 * a token issued to a platform admin keeps asserting that claim for up to a
 * month — including after the flag has been revoked in the database. Until it
 * expires the holder can still suspend any tenant and change any tenant's
 * subscription tier, which is the widest privilege in the system.
 *
 * The templates routes already did a live lookup for the same decision, so the
 * codebase disagreed with itself and this guard was the weaker half. Doing the
 * same live check here makes revocation take effect on the next request.
 *
 * The cost is one lookup by primary key, on platform routes only — a handful of
 * admin endpoints, not anything on a hot path.
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
