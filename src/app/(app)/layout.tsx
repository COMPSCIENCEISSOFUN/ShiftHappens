/**
 * App Layout (Boundary Layer)
 *
 * The checks that are true of every signed-in page, and nothing else:
 * a session exists, the user still exists in the database, and a platform
 * admin belongs in their own console rather than here.
 *
 * ## Why the chrome moved out
 *
 * This layout sits ABOVE `org/[orgId]` in the route tree, so it never sees the
 * org id. It nonetheless resolved the org name, the role badge, the suspension
 * state and the permission set every page gates on — all from `orgs[0]`, the
 * user's arbitrarily-first organisation — while the page below read a different
 * id from the URL.
 *
 * A layout cannot answer a question about a segment beneath it. So it no longer
 * tries: `org/[orgId]/layout.tsx` owns everything org-scoped, including the
 * membership guard that decides whether the page is served at all, and the
 * org-agnostic pages carry their own shell.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getPlatformAdmin } from "@/lib/platform-guard";
import { ProfileService } from "@/services/profile.service";

const profileService = new ProfileService();

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  /*
   * Platform admins have their own console — send them to it.
   *
   * Asked of the database, not of the token. The JWT claim is written once at
   * sign-in and never revalidated, so a REVOKED platform admin was redirected
   * here for up to thirty days while the platform layout (which now also asks
   * live) sent them back — leaving them unable to reach either console.
   */
  const platformAdmin = await getPlatformAdmin();
  if (platformAdmin) {
    redirect("/platform-admin");
  }

  // A session can outlive the account it names. Deleting a user does not
  // invalidate their JWT, so without this the token keeps working.
  const dbUser = await profileService.getProfile(session.user.id);
  if (!dbUser) {
    redirect("/login");
  }

  return <>{children}</>;
}
