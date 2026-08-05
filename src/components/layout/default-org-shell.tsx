/**
 * The chrome for the signed-in pages that are not about a particular
 * organisation: the dashboard, onboarding, and the personal profile.
 *
 * These have no org id in their URL, so "which organisation" has to be answered
 * some other way, and the honest answer is a default rather than a fact. The
 * user's organisations are ordered oldest-first and the first is taken — which
 * is what the app always did, except that the ordering is now deterministic.
 * `findByUserId` had no `orderBy`, so Postgres was free to return a different
 * organisation on successive requests, and the sidebar's org name, role badge
 * and menu could change between two loads of the same page.
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

  // No organisation yet — onboarding is exactly this state, and the sidebar
  // renders its org-agnostic entries when `orgId` is undefined.
  if (orgs.length === 0) {
    return (
      <AppShell
        user={{ name: dbUser.name, email: dbUser.email }}
        permissions={[]}
      >
        {children}
      </AppShell>
    );
  }

  const org = orgs[0];

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
    >
      {children}
    </AppShell>
  );
}
