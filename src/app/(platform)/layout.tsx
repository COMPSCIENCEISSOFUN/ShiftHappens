/**
 * Platform Admin Layout (Boundary Layer)
 * 
 * Separate layout for platform administration pages.
 * Uses its own sidebar with platform-level navigation.
 * Only accessible to users with isPlatformAdmin flag.
 */
import { redirect } from "next/navigation";
import { getPlatformAdmin } from "@/lib/platform-guard";
import { PlatformSidebar } from "@/components/layout/platform-sidebar";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getPlatformAdmin();
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen">
      <PlatformSidebar user={user} />
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
