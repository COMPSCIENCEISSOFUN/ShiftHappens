/**
 * The dashboard for ONE organisation (Boundary Layer).
 *
 * ## Why this moved
 *
 * It used to live at `/dashboard` and open with `const org = orgs[0]` — the
 * user's oldest organisation. For anyone in one organisation that is the right
 * answer and nothing was visibly wrong. For anyone in two it was a coin toss
 * the user could not call: no picker, no switcher, and the sidebar's Dashboard
 * link pointed back at `/dashboard`, so standing inside organisation B and
 * pressing Dashboard took you to organisation A's numbers under organisation
 * A's name.
 *
 * `org/[orgId]/layout.tsx` had already fixed exactly this for every other page
 * — its docblock is about the same defect — and the dashboard was the one page
 * left outside that subtree. So this is not a new mechanism; it is the last
 * page joining the one that already existed.
 *
 * What it inherits by being here, rather than reimplementing:
 *
 *   - the membership guard, so a stranger gets `notFound()` and not a rendered
 *     page about somebody else's organisation
 *   - the suspension check, for THIS organisation
 *   - the plan and the permission set, from the org in the URL
 *
 * ## Why it re-reads the membership the layout just read
 *
 * Not to re-authorise — the layout has already refused if there is no
 * membership. This page needs the membership as DATA: which of the three
 * dashboards to render is a question about the caller's permissions and
 * department scope, and Next gives a page no way to receive a value its layout
 * computed. One query, and it is the query the decision needs.
 *
 * ## Why it switches on permissions and not on the role string
 *
 * `switch (role)` here and `if (role === …)` in the API route were the same
 * decision made twice, and both ignored the permission catalogue. The route
 * gates each section on the permission that owns it; this picks the component
 * that renders those sections, from the same permissions, so the two cannot
 * come to disagree about what the caller is getting.
 *
 *   - no `reports:view` → the personal dashboard. Nothing else would have
 *     anything in it, because the route sends no org sections without it.
 *   - `reports:view`, unrestricted → the admin dashboard, the only one that
 *     renders the two org-wide sections.
 *   - `reports:view`, scoped → the manager dashboard, scoped to their own
 *     departments.
 *
 * BCE compliant: only imports from Control layer (services).
 */
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";
import AdminDashboard from "@/components/dashboard/admin-dashboard";
import ManagerDashboard from "@/components/dashboard/manager-dashboard";
import StaffDashboard from "@/components/dashboard/staff-dashboard";

const orgService = new OrganizationService();
const accessService = new AccessService();

export default async function OrgDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  // Next 16 — route params arrive as a Promise.
  const { orgId } = await params;

  const session = await auth();
  if (!session?.user) redirect("/login");

  /*
   * `notFound()`, matching the layout above, rather than a redirect or a 403.
   * A non-member and a non-existent organisation must be indistinguishable, or
   * the URL becomes a way to discover which organisation ids are real.
   *
   * Unreachable in practice while the layout stands, and kept anyway: a page
   * must not depend on an ancestor having run, and this is the file somebody
   * will copy when they add the next org-scoped page.
   */
  const membership = await accessService.getMembership(session.user.id, orgId);
  if (!membership) notFound();

  const org = await orgService.getOrganization(orgId);
  if (!org) notFound();

  const firstName = session.user.name?.split(" ")[0] || "";
  const props = { orgId, orgName: org.name, userName: firstName };

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
