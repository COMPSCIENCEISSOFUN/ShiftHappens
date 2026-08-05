/**
 * Registration page (Boundary Layer).
 *
 * Same guard and the same reason as the sign-in page: creating a second account
 * from inside a live session is a mistake, not a use case. Accepting an
 * invitation is the legitimate way to gain another membership, and that page
 * deliberately stays reachable while signed in.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { RegisterForm } from "@/components/auth/register-form";

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return <RegisterForm />;
}
