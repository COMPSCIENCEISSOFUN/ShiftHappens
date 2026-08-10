/**
 * The guard for everything under `/org/[orgId]` (Boundary Layer).
 *
 * ## What was missing
 *
 * Nothing server-side read the org id from the URL. `middleware.ts` matches
 * `/api/:path*` only, so pages never reach it; `(app)/layout.tsx` checks that a
 * session exists and stops there; and every page beneath this point is a client
 * component that takes its org id from `useParams()`.
 *
 * So any signed-in user could type `/org/<someone-else's-id>/members` and be
 * served a 200 with the whole product: sidebar, org name, headings, stat tiles,
 * action buttons, modals. Only the XHRs behind it answered 403. The data was
 * never exposed — every route independently resolves the caller's membership
 * against the same id — but serving the page at all is wrong twice over. It
 * tells a stranger the URL is meaningful, and it renders THEIR org's name and
 * role badge onto a page about an organisation they have nothing to do with.
 *
 * ## What it does
 *
 * Resolves the membership for the org in the URL, once, on the server:
 *
 *   no membership   → `notFound()`
 *   suspended org   → the suspension banner, for THIS org
 *   otherwise       → the chrome, with THIS org's permissions
 *
 * `notFound()` rather than a redirect or a 403, deliberately. A non-member and
 * a non-existent organisation must be indistinguishable, or the URL becomes a
 * way to discover which organisation ids are real.
 *
 * ## Why the permissions are resolved here and not above
 *
 * They used to come from `orgs[0]` — the user's arbitrarily-first organisation,
 * with no `orderBy` behind it — while the page below read a different id from
 * the URL. For a single-org user those are the same value. For anyone in two
 * they are not, and it failed in both directions: an admin of org A visiting
 * org B's settings saw the screen fully unlocked, while an admin of org B whose
 * first org happened to be A was told settings are managed by company admins,
 * in their own organisation.
 *
 * ## Still not a security boundary
 *
 * This decides whether the PAGE is served. Every action on it is refused
 * independently by `requirePermission` at its own route — which is what would
 * still stop a hand-written request if this file were deleted tomorrow.
 */
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AccessService } from "@/services/access.service";
import { OrganizationService } from "@/services/organization.service";
import { ProfileService } from "@/services/profile.service";
import { RoleService } from "@/services/role.service";
import { AppShell } from "@/components/layout/app-shell";
import {
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";
import { OrgSuspendedBanner } from "@/components/layout/org-suspended-banner";

const accessService = new AccessService();
const orgService = new OrganizationService();
const profileService = new ProfileService();
const roleService = new RoleService();

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  // Next 16 — route params arrive as a Promise.
  const { orgId } = await params;

  // The parent layout has already done this, but a layout must not depend on
  // an ancestor having run: they are composed, not sequenced, and this one is
  // the guard.
  const session = await auth();
  if (!session?.user) redirect("/login");

  const membership = await accessService.getMembership(session.user.id, orgId);
  if (!membership) notFound();

  const org = await orgService.getOrganization(orgId);
  if (!org) notFound();

  const dbUser = await profileService.getProfile(session.user.id);
  if (!dbUser) redirect("/login");

  // Suspension of THIS organisation. It was previously read off `orgs[0]`, so
  // a user whose first org was active could browse a suspended second one.
  if (org.status !== "active") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <OrgSuspendedBanner />
      </div>
    );
  }

  const permissions = [...accessService.permissionsFor(membership)];

  /*
   * The switcher's list.
   *
   * One extra query per page load in this subtree, and there is no way to know
   * whether the switcher is needed without asking — "does this user belong to
   * a second organisation" is the question itself. It is the same query the
   * dashboard signpost runs, active-only and totally ordered, so the sidebar's
   * list and the picker's list cannot come to disagree about what the user
   * belongs to.
   *
   * Only the id and the name cross into the client component. The rows carry a
   * membership and a subscription tier as well, and neither is any of the
   * sidebar's business: the plan shown in the badge is THIS organisation's,
   * resolved below, and shipping the others would put a second answer to the
   * same question in the same component.
   */
  const organizations = (
    await orgService.getUserOrganizations(session.user.id)
  ).map((o) => ({ id: o.id, name: o.name }));

  // The custom role's label, for the sidebar badge. Scoped to this org — the
  // role always belongs to it, since `assignCustomRole` refuses anything else.
  const customRoleId = (membership as Record<string, unknown>)
    .customRoleId as string | null | undefined;
  const customRoleLabel = customRoleId
    ? (await roleService.getById(customRoleId, orgId))?.displayLabel
    : undefined;

  return (
    <AppShell
      user={{ name: dbUser.name, email: dbUser.email }}
      orgId={orgId}
      orgName={org.name}
      organizations={organizations}
      role={membership.role}
      employmentType={
        (membership as Record<string, unknown>).employmentType as
          | string
          | undefined
      }
      customRoleLabel={customRoleLabel}
      permissions={permissions}
      /*
       * The plan, from the organisation this layout already loaded for the
       * suspension check — so it costs no query and is correct on the first
       * paint. The sidebar used to fetch it, which meant every page load
       * briefly offered two links the plan did not include.
       *
       * Validated rather than cast: the column is a plain string, and an
       * unrecognised value must fall back to the RESTRICTED end. Trusting it
       * would let a typo in the database unlock Enterprise features.
       */
      tier={
        SUBSCRIPTION_TIERS.includes(org.subscriptionTier as SubscriptionTier)
          ? (org.subscriptionTier as SubscriptionTier)
          : "free"
      }
    >
      {children}
    </AppShell>
  );
}
