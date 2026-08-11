/**
 * Sign-in page (Boundary Layer).
 *
 * Guarded here rather than in the auth layout: its siblings — verify-email,
 * reset-password, accept-invitation — are all reached from a link in a mail and
 * are legitimately opened by someone who already has a session, so the layout
 * cannot apply one rule to all of them.
 *
 * Signing in from inside a session is the case worth refusing. It is how a
 * shared machine silently swaps whose session is live, and how someone ends up
 * authenticated as an account they did not mean to use.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginForm } from "@/components/auth/login-form";
import { ProfileService } from "@/services/profile.service";

const profileService = new ProfileService();

export default async function LoginPage() {
  const session = await auth();
  /*
   * A JWT can outlive the account it names. Sending that stale token to
   * Dashboard creates a loop: the signed-in layout rejects the missing user
   * back to Login, then Login sees the same token and redirects again.
   */
  if (session?.user && (await profileService.getProfile(session.user.id))) {
    redirect("/dashboard");
  }

  return <LoginForm />;
}
