/**
 * Dashboard Page (Boundary Layer)
 *
 * Server component that resolves the user's session and decides which of the
 * three dashboard components to render. All data fetching happens inside those
 * components, against /api/organizations/[orgId]/dashboard.
 *
 * ## Why this stopped switching on the role string
 *
 * `switch (role)` here and `if (role === …)` in the API route were the same
 * decision made twice, and both ignored the permission catalogue. The route now
 * gates each section on the permission that owns it; this picks the component
 * that renders those sections, from the same permissions, so the two cannot
 * come to disagree about what the caller is getting.
 *
 * The rule is the one section that decides the shape:
 *
 *   - no `reports:view` → the personal dashboard. Nothing else would have
 *     anything in it, because the route sends no org sections without it. A
 *     manager whose custom role removes reporting lands here, which is the
 *     removal finally taking effect rather than an org page rendering empty.
 *   - `reports:view`, unrestricted → the admin dashboard, which is the only one
 *     that renders the two org-wide sections.
 *   - `reports:view`, scoped → the manager dashboard. A senior staff member
 *     granted reporting now reaches it, scoped to their own departments, which
 *     is what the grant was for.
 *
 * The three system roles land exactly where they landed before. What changed is
 * that a custom role can now move somebody, which is the whole feature.
 *
 * BCE compliant: only imports from Control layer (services).
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";
import AdminDashboard from "@/components/dashboard/admin-dashboard";
import ManagerDashboard from "@/components/dashboard/manager-dashboard";
import StaffDashboard from "@/components/dashboard/staff-dashboard";

const orgService = new OrganizationService();
const accessService = new AccessService();

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const orgs = await orgService.getUserOrganizations(session.user.id);

  if (orgs.length === 0) {
    redirect("/onboarding");
  }

  const org = orgs[0];
  const firstName = session.user.name?.split(" ")[0] || "";
  const props = { orgId: org.id, orgName: org.name, userName: firstName };

  /*
   * Re-read the membership rather than using the one `getUserOrganizations`
   * returned, because only this query resolves the custom role's permissions —
   * and because it is the same lookup the API route authorises with, so the
   * page cannot render a dashboard the endpoint will then refuse to fill.
   *
   * A null membership is narrow but real: `getUserOrganizations` is active-only
   * and returns nothing for a deactivated member, so they are redirected above
   * before reaching this — the gap is a deactivation landing BETWEEN the two
   * queries. The personal dashboard is the safe answer for that race, being the
   * one that asks for nothing but the caller's own data, and the API will
   * refuse even that.
   */
  const membership = await accessService.getMembership(session.user.id, org.id);
  if (!membership) return <StaffDashboard {...props} />;

  const permissions = accessService.permissionsFor(membership);
  if (!permissions.has("reports:view")) return <StaffDashboard {...props} />;

  /*
   * `departmentScopeFor(...) === null` and `role === "company_admin"` are the
   * same test today, and swapping one for the other survives every test in
   * `dashboard-switch` — an equivalent mutant, not a gap. `departmentScopeFor`
   * returns null for exactly one role, which `tests/lib/department-scope`
   * pins, so nothing can distinguish them without changing that helper.
   *
   * Kept as the scope call anyway, for the reason the route uses it: page and
   * endpoint then read scope through one definition, and a second unrestricted
   * case would reach both at once rather than one of them.
   */
  return departmentScopeFor(membership) === null ? (
    <AdminDashboard {...props} />
  ) : (
    <ManagerDashboard {...props} />
  );
}
