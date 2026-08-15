/**
 * The dashboard for ONE organisation (Boundary Layer).
 *
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
