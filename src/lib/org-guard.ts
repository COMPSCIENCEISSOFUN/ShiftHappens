/**
 * Organization Access Guard
 *
 * Validates that an organization is active before allowing access.
 * Used by API routes and layouts to enforce org suspension.
 *
 * This delegates to the Control layer rather than querying Prisma itself: it is
 * imported by Boundary code (routes and the app layout), and a Boundary helper
 * reaching Entity directly is the BCE violation this indirection removes.
 */
import { AccessService } from "@/services/access.service";

const accessService = new AccessService();

/**
 * Checks if an organization is active.
 * Returns false if suspended or not found.
 */
export async function checkOrgActive(orgId: string): Promise<boolean> {
  return accessService.isOrgActive(orgId);
}
