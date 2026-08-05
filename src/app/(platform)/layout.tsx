/**
 * Platform Admin Layout (Boundary Layer)
 * 
 * Separate layout for platform administration pages.
 * Uses its own sidebar with platform-level navigation.
 *
 * ## Why this asks the database and not the session
 *
 * It used to read `session.user.isPlatformAdmin`. That claim is written into
 * the JWT once at sign-in and never revalidated, and sessions use the JWT
 * strategy with NextAuth's 30-day default — so a revoked platform admin kept
 * rendering this entire console for up to a month. The API routes beneath it
 * were already immune, because `getPlatformAdmin()` does a live lookup for
 * exactly this reason and says so in its own docblock; this layout was the one
 * place still trusting the token, which made the codebase disagree with itself
 * about the widest privilege in the system.
 *
 * It also left the holder stranded: `(app)/layout.tsx` redirects anyone
 * carrying the claim here, so a revoked admin could reach neither console. Both
 * ends now ask the same question of the same source.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getPlatformAdmin } from "@/lib/platform-guard";
import { PlatformSidebar } from "@/components/layout/platform-sidebar";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const admin = await getPlatformAdmin();
  if (!admin) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen">
      <PlatformSidebar user={session.user} />
      {/*
        Identical to the org-level layout's <main>. `pt-18` clears the fixed
        hamburger button on small screens; `overflow-x-hidden` stops a wide
        table from pushing the whole page sideways instead of scrolling itself.
        Both were missing here, which is why platform admin behaved differently
        on a phone.
      */}
      <main className="flex-1 overflow-x-hidden px-4 pt-18 pb-6 md:p-6">
        {children}
      </main>
    </div>
  );
}