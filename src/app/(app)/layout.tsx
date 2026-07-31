/**
 * App Layout (Boundary Layer)
 *
 * Shared layout for all authenticated pages.
 * Validates session user still exists in database.
 * Fetches org, role, employment type, and custom role for the sidebar.
 * Redirects unauthenticated or invalid users to /login.
 * Shows suspension message inline if org is suspended.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { OrganizationService } from "@/services/organization.service";
import { AccessService } from "@/services/access.service";
import { ProfileService } from "@/services/profile.service";
import { RoleService } from "@/services/role.service";
import { OrgSuspendedBanner } from "@/components/layout/org-suspended-banner";

const orgService = new OrganizationService();
const accessService = new AccessService();
const profileService = new ProfileService();
const roleService = new RoleService();

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // Platform admins have their own layout — redirect them
  const isPlatformAdmin = (session.user as unknown as Record<string, unknown>).isPlatformAdmin;
  if (isPlatformAdmin) {
    redirect("/platform-admin");
  }

  // Validate the session user still exists in the database
  const dbUser = await profileService.getProfile(session.user.id);
  if (!dbUser) {
    redirect("/login");
  }

  // Get user's first organization and role for sidebar
  const orgs = await orgService.getUserOrganizations(session.user.id);
  let orgId: string | undefined;
  let orgName: string | undefined;
  let role: string | undefined;
  let employmentType: string | undefined;
  let customRoleLabel: string | undefined;
  let orgSuspended = false;

  if (orgs.length > 0) {
    orgId = orgs[0].id;
    orgName = orgs[0].name;

    if (orgs[0].status !== "active") {
      orgSuspended = true;
    } else {
      const membership = await accessService.getMembership(
        session.user.id,
        orgId
      );
      role = membership?.role;
      employmentType = (membership as Record<string, unknown>)?.employmentType as string | undefined;

      // Fetch custom role display label if assigned. Scoped to the org the
      // sidebar is rendering: the role always belongs to it (assignCustomRole
      // rejects anything else), so this reads the same label as before while
      // keeping the lookup tenant-scoped like every other query.
      const customRoleId = (membership as Record<string, unknown>)?.customRoleId as string | undefined;
      if (customRoleId) {
        const customRole = await roleService.getById(customRoleId, orgId);
        customRoleLabel = customRole?.displayLabel;
      }
    }
  }

  if (orgSuspended) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <OrgSuspendedBanner />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <AppSidebar
        user={{ name: dbUser.name, email: dbUser.email }}
        orgId={orgId}
        orgName={orgName}
        role={role}
        employmentType={employmentType}
        customRoleLabel={customRoleLabel}
      />
      <main className="flex-1 overflow-x-hidden px-4 pt-18 pb-6 md:p-6">{children}</main>
    </div>
  );
}
