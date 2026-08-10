/**
 * `/dashboard` — a signpost, and nothing else (Boundary Layer).
 *
 * ## What this used to be, and why it stopped
 *
 * It used to BE the dashboard, opening with `const org = orgs[0]`. That works
 * for a user in one organisation and is a coin toss for a user in two: there
 * was no picker, no switcher, and no way to tell which organisation you were
 * looking at except by reading the name in the sidebar.
 *
 * The fix is not to remember a choice somewhere. It is to make the
 * organisation part of the address, as it already is for every other page in
 * the product, so that "which organisation am I looking at" has exactly one
 * answer and it is visible in the URL. A stored choice would have been a
 * FOURTH place with an opinion — `dashboard`, `(app)/layout`, the shell, and
 * the cookie — all of which must then agree. That arrangement is precisely how
 * the shell came to believe every organisation was on the Free plan while the
 * page inside it knew better, and nothing failed loudly for months.
 *
 * ## Why the address survives anyway
 *
 * `/dashboard` is linked from sign-in, from registration, from the platform
 * console and from onboarding, and it is what people bookmark and type. It
 * stays as the front door; it just no longer pretends to know which room.
 *
 *   no organisations   → onboarding, which is that state
 *   exactly one        → straight into it, so the common case never sees a
 *                        chooser with one option on it
 *   two or more        → the picker
 *
 * ## Why there is no layout beside this file
 *
 * There was one, and it wrapped this page in the full signed-in chrome —
 * sidebar, org name, role badge, plan — for a page that renders nothing and
 * redirects. Five queries and a menu, painted for no one. A signpost needs no
 * chrome.
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
