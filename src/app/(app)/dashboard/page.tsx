/**
 * `/dashboard` — a signpost, and nothing else (Boundary Layer).
 *
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";

const orgService = new OrganizationService();

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const orgs = await orgService.getUserOrganizations(session.user.id);

  if (orgs.length === 0) redirect("/onboarding");

  /*
   * `[0]` of a list of one is not a default — it is the only element. The
   * distinction is the whole change: every other `orgs[0]` in the codebase was
   * a guess made on behalf of somebody who might have meant the other one.
   */
  if (orgs.length === 1) redirect(`/org/${orgs[0].id}/dashboard`);

  redirect("/select-organization");
}
