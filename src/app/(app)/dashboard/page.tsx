/**
 * Dashboard Page (Boundary Layer)
 *
 * Server component that resolves the user's session and role,
 * then renders the appropriate role-specific client dashboard.
 * All data fetching happens in the client components via the
 * /api/organizations/[orgId]/dashboard endpoint.
 *
 * BCE compliant: only imports from Control layer (services).
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";
import AdminDashboard from "@/components/dashboard/admin-dashboard";
import ManagerDashboard from "@/components/dashboard/manager-dashboard";
import StaffDashboard from "@/components/dashboard/staff-dashboard";

const orgService = new OrganizationService();

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const orgs = await orgService.getUserOrganizations(session.user.id);

  if (orgs.length === 0) {
    redirect("/onboarding");
  }

  const org = orgs[0];
  const role = org.memberships[0]?.role;
  const firstName = session.user.name?.split(" ")[0] || "";

  switch (role) {
    case "staff":
      return <StaffDashboard orgId={org.id} orgName={org.name} userName={firstName} />;
    case "manager":
      return <ManagerDashboard orgId={org.id} orgName={org.name} userName={firstName} />;
    default:
      return <AdminDashboard orgId={org.id} orgName={org.name} userName={firstName} />;
  }
}
