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

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return <LoginForm />;
}
