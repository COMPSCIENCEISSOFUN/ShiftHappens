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
 * membership. This page needs the membership as DATA: what the caller may see
 * is a question about their permissions and their department scope, and Next
 * gives a page no way to receive a value its layout computed. One query, and it
 * is the query the answer needs.
 *
 * ## Why it no longer picks a dashboard
 *
 * It used to `switch` between an admin, a manager and a staff component. That
 * is only correct while the population of callers is those three, and custom
 * roles make it combinatorial — a member granted `certifications:review`
 * without `reports:view` was routed to the personal dashboard while the API
 * cheerfully returned the certification section, which nothing then rendered.
 *
 * This page's whole job is now to state the reader — what they hold, what they
 * are scoped to, whether they can hold a shift — and hand it down.
 * `src/lib/dashboard-cards.ts` decides what that reader sees, and the same
 * three facts gate the endpoint, so screen and payload cannot come to disagree.
 *
 * BCE compliant: only imports from Control layer (services) and shared lib.
 */
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";
import { canBeRostered } from "@/lib/role-config";
import { Dashboard } from "@/components/dashboard/dashboard";

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

  return (
    <Dashboard
      orgId={orgId}
      orgName={org.name}
      userName={session.user.name?.split(" ")[0] || ""}
      /*
       * An array, not the Set the registry works in. This crosses into a client
       * component and a Set does not survive serialisation — it would arrive as
       * `{}`, every `.has()` would answer false, and the reader would silently
       * qualify for nothing. Sorted so the prop is stable between renders.
       */
      permissions={[...accessService.permissionsFor(membership)].sort()}
      /*
       * `null` is unrestricted. An EMPTY array is a real answer and not a
       * missing one — a manager assigned to no departments is scoped to
       * nothing, and the cards that need a team correctly withhold themselves.
       */
      departmentScope={departmentScopeFor(membership)}
      /*
       * Not a permission. Whether the engine would ever consider this person
       * for a shift is a structural fact, stated once in `role-config` so the
       * endpoint and the screen cannot disagree about who has self-service data
       * to show.
       */
      rosterable={canBeRostered(membership.role)}
    />
  );
}
