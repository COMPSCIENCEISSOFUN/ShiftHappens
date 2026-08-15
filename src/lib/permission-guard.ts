/**
 * The permission gate for API routes (Boundary Layer).
 *
 */
import { NextResponse } from "next/server";
import { AccessService } from "@/services/access.service";
import { SubscriptionService } from "@/services/subscription.service";
import { PERMISSION_FEATURE } from "@/lib/permissions";
import { FeatureNotAvailableError } from "@/lib/subscription-tiers";

const accessService = new AccessService();
const subscriptionService = new SubscriptionService();

type Membership = NonNullable<Awaited<ReturnType<AccessService["getMembership"]>>>;

/**
 * Either a membership to carry on with, or the response to return.
 *
 * A discriminated union rather than throwing, because the alternative is every
 * route growing a `catch` that has to tell an authorisation failure apart from
 * a genuine error — and the one that forgets returns 500 for a permission
 * denial, which is both wrong and a worse thing to leak.
 */
export type PermissionResult =
  | { ok: true; membership: Membership }
  | { ok: false; response: NextResponse };

/**
 * Resolve the caller's membership and check they hold `permission`.
 *
 * Usage:
 *     const gate = await requirePermission(user.id, orgId, "tasks:create");
 *     if (!gate.ok) return gate.response;
 *     const membership = gate.membership;
 */
export async function requirePermission(
  userId: string,
  organizationId: string,
  permission: string
): Promise<PermissionResult> {
  const membership = await accessService.getMembership(userId, organizationId);
  if (!membership) {
    return { ok: false, response: forbidden() };
  }

  const feature = PERMISSION_FEATURE[permission];
  if (feature) {
    try {
      await subscriptionService.enforceFeatureAccess(organizationId, feature);
    } catch (error) {
      if (error instanceof FeatureNotAvailableError) {
        // The plan's own message, which names the feature and the tier that
        // grants it. "Forbidden" here would send an admin hunting for a
        // permissions problem that does not exist.
        return {
          ok: false,
          response: NextResponse.json({ error: error.message }, { status: 403 }),
        };
      }
      throw error;
    }
  }

  if (!accessService.permissionsFor(membership).has(permission)) {
    return { ok: false, response: forbidden() };
  }

  return { ok: true, membership };
}

/**
 * As `requirePermission`, but satisfied by ANY of the listed permissions.
 *
 * For an endpoint several audiences legitimately reach. `GET /roles` is the
 * case that made it necessary: the roles screen reads the list to EDIT it, but
 * the members screen reads it to assign one and the work-rules screen reads it
 * to target one, so `roles:manage` alone would break two unrelated pages while
 * membership alone left the list open to everybody.
 *
 * ## One membership lookup, not one per candidate
 *
 * The first version called `requirePermission` in a loop, which re-ran the
 * authorisation query for every name in the list — an extra round trip per
 * candidate on the hot path, to answer a question one query already answers.
 *
 * ## Which denial is returned
 *
 * The PLAN's message when a plan-gated candidate was the reason, and a plain
 * 403 otherwise. The loop version kept the *last* denial of any kind, so
 * `["audit:view", "reports:view"]` discarded the upgrade message and answered
 * "Forbidden" — sending an admin to hunt for a permissions problem that did not
 * exist, which is exactly what `requirePermission`'s plan branch was written to
 * prevent.
 */
export async function requireAnyPermission(
  userId: string,
  organizationId: string,
  permissions: readonly string[]
): Promise<PermissionResult> {
  const membership = await accessService.getMembership(userId, organizationId);
  if (!membership) {
    return { ok: false, response: forbidden() };
  }

  const held = accessService.permissionsFor(membership);
  let planDenial: NextResponse | null = null;

  for (const permission of permissions) {
    if (!held.has(permission)) continue;

    const feature = PERMISSION_FEATURE[permission];
    if (!feature) return { ok: true, membership };

    // Plan before permission, the same order `requirePermission` uses: a plan
    // can veto a permission, a permission can never buy a plan.
    try {
      await subscriptionService.enforceFeatureAccess(organizationId, feature);
      return { ok: true, membership };
    } catch (error) {
      if (error instanceof FeatureNotAvailableError) {
        planDenial ??= NextResponse.json(
          { error: error.message },
          { status: 403 }
        );
        continue;
      }
      throw error;
    }
  }

  return { ok: false, response: planDenial ?? forbidden() };
}

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
