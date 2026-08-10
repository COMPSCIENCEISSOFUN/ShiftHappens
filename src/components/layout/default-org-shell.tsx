/**
 * The chrome for the signed-in pages that are not about a particular
 * organisation: onboarding, and the personal profile.
 *
 * ## It no longer guesses
 *
 * It used to take `orgs[0]` — the user's oldest organisation — and decorate
 * these pages with that organisation's name, role badge, plan and menu. For a
 * user in one organisation that is the right answer. For a user in two it was
 * a guess presented as a fact: open your profile from inside organisation B
 * and the sidebar quietly became organisation A.
 *
 * Now it resolves an organisation only when there is nothing to resolve:
 *
 *   exactly one  → that one, which is not a default but the only element
 *   none, or two
 *   or more      → the org-agnostic chrome, with no org name, no plan badge
 *                  and no org links
 *
 * The second case is a deliberate, visible reduction rather than a hidden
 * wrong answer. These pages are about the PERSON, not an organisation, and the
 * profile page already lists every organisation the caller belongs to — so the
 * one screen where the menu goes quiet is also the screen that says why.
 *
 * The dashboard used to come through here too. It now lives under
 * `/org/[orgId]/dashboard`, where the organisation is a fact rather than a
 * default, and `/dashboard` is a redirect with no chrome at all.
 *
 * Anything under `/org/[orgId]` must NOT come through here. That subtree has a
 * real answer in its URL and a layout that reads it — see
 * `app/(app)/org/[orgId]/layout.tsx`.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AccessService } from "@/services/access.service";
import { OrganizationService } from "@/services/organization.service";
import { ProfileService } from "@/services/profile.service";
import { RoleService } from "@/services/role.service";
import { AppShell } from "@/components/layout/app-shell";
import { OrgSuspendedBanner } from "@/components/layout/org-suspended-banner";
import {
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

const accessService = new AccessService();
const orgService = new OrganizationService();
const profileService = new ProfileService();
const roleService = new RoleService();

export async function DefaultOrgShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const dbUser = await profileService.getProfile(session.user.id);
  if (!dbUser) redirect("/login");

  const orgs = await orgService.getUserOrganizations(session.user.id);

  /*
   * `[0]` of a list of ONE is the only element. `[0]` of a list of several is
   * a guess, and that guess is what this file existed to make.
   */
  const org = orgs.length === 1 ? orgs[0] : null;

  /*
   * Nothing to name. Two states reach this, and both are honest:
   *
   *   no organisation yet — onboarding is exactly this state
   *   more than one       — and no way to tell which is meant, on a page whose
   *                         URL does not say
   *
   * The sidebar renders its org-agnostic entries when `orgId` is undefined,
   * and `AppShell` defaults the plan to Free, so tier-gated links stay hidden
   * rather than being offered against an organisation nobody has named.
   */
  if (!org) {
    return (
      <AppShell
        user={{ name: dbUser.name, email: dbUser.email }}
        permissions={[]}
      >
        {children}
      </AppShell>
    );
  }

  if (org.status !== "active") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <OrgSuspendedBanner />
      </div>
    );
  }

  const membership = await accessService.getMembership(session.user.id, org.id);
  const permissions = membership
    ? [...accessService.permissionsFor(membership)]
    : [];

  const customRoleId = (membership as Record<string, unknown> | null)
    ?.customRoleId as string | null | undefined;
  const customRoleLabel = customRoleId
    ? (await roleService.getById(customRoleId, org.id))?.displayLabel
    : undefined;

  return (
    <AppShell
      user={{ name: dbUser.name, email: dbUser.email }}
      orgId={org.id}
      orgName={org.name}
      role={membership?.role}
      employmentType={
        (membership as Record<string, unknown> | null)?.employmentType as
          | string
          | undefined
      }
      customRoleLabel={customRoleLabel}
      permissions={permissions}
      /*
       * The plan — which this shell did not pass at all.
       *
       * `AppShell` defaults `tier` to "free", deliberately, so that the
       * org-agnostic branch above hides tier-gated links rather than offering
       * them. But this branch HAS an organisation, and omitting the prop here
       * meant every page using this chrome — the dashboard above all — believed
       * every organisation was on Free.
       *
       * It was invisible for as long as nothing on those pages was plan-gated:
       * the only symptom was the sidebar dropping Roles and Audit Log on the
       * dashboard and restoring them one navigation later, on any `/org/[orgId]`
       * page, whose layout does pass this. Two menus for one organisation,
       * depending which page you were standing on.
       *
       * `org` is already loaded for the suspension check, and `findByUserId`
       * uses `include` rather than `select`, so this costs no query and is
       * correct on the first paint — which is what §5.19 claimed of the tier
       * and was only ever true of the other layout.
       *
       * Validated rather than cast, for the same reason as that layout: the
       * column is a plain string, and an unrecognised value must fall back to
       * the RESTRICTED end rather than unlock Enterprise on a typo.
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
