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
import { getAuthenticatedUser } from "@/lib/auth-guard";
import { cookies } from "next/headers";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { OrganizationService } from "@/services/organization.service";
import { MembershipRepository } from "@/repositories/membership.repository";
import { UserRepository } from "@/repositories/user.repository";
import { OrgSuspendedBanner } from "@/components/layout/org-suspended-banner";
import { effectivePermissions } from "@/lib/permission-guard";

const orgService = new OrganizationService();
const membershipRepo = new MembershipRepository();
const userRepo = new UserRepository();

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect("/login");
  }

  // Platform admins have their own layout — redirect them
  if (user.isPlatformAdmin) {
    redirect("/platform-admin");
  }

  // Validate the session user still exists in the database
  const dbUser = await userRepo.findPublicById(user.id);
  if (!dbUser) {
    redirect("/login");
  }

  // Get user's first organization and role for sidebar
  const orgs = await orgService.getUserOrganizations(user.id);
  let orgId: string | undefined;
  let orgName: string | undefined;
  let role: string | undefined;
  let employmentType: string | undefined;
  let customRoleLabel: string | undefined;
  let permissions: string[] = [];
  let orgSuspended = false;

  if (orgs.length > 0) {
    const requestedOrgId = (await cookies()).get("activeOrganizationId")?.value;
    const requestedOrg = orgs.find((org) => org.id === requestedOrgId);
    const selectedOrg =
      (requestedOrg?.status === "active" ? requestedOrg : undefined) ??
      orgs.find((org) => org.status === "active") ??
      requestedOrg ??
      orgs[0];
    orgId = selectedOrg.id;
    orgName = selectedOrg.name;

    if (selectedOrg.status !== "active") {
      orgSuspended = true;
    } else {
      const membership = await membershipRepo.findByUserAndOrg(
        user.id,
        orgId
      );
      role = membership?.role;
      employmentType = (membership as Record<string, unknown>)?.employmentType as string | undefined;
      if (membership) {
        customRoleLabel = membership.customRole?.displayLabel;
        permissions = [...effectivePermissions(membership)];
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
        permissions={permissions}
        organizations={orgs.map((org) => ({ id: org.id, name: org.name, status: org.status }))}
      />
      <main className="app-content flex-1 overflow-x-hidden px-4 pt-18 pb-6 md:p-6">{children}</main>
    </div>
  );
}
