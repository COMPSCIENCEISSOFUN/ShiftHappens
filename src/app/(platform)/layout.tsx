/**
 * Platform Admin Layout (Boundary Layer)
 * 
 * Separate layout for platform administration pages.
 * Uses its own sidebar with platform-level navigation.
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