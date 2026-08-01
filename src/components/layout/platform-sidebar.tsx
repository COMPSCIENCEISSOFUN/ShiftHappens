/**
 * Platform Admin Sidebar Component (Boundary Layer)
 *
 * Dedicated sidebar for platform administration.
 * Dark theme to visually distinguish from org-level app.
 * Shows platform-level navigation with icons.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Building2,
  LayoutGrid,
  LayoutTemplate,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface PlatformSidebarProps {
  user: {
    name: string | null;
    email: string;
  };
}

interface PlatformNavLink {
  href: string;
  label: string;
  /**
   * A component, not a string. These were emoji (`📊 🏢 📋`), which is the one
   * place in the app where that was most visible: this panel is permanently
   * dark, and an emoji is an OS-supplied colour bitmap that cannot inherit
   * `currentColor` — so the three nav marks stayed full-colour while the label
   * beside them moved between grey, hover-grey and active-blue, and they did
   * not dim with the inactive items.
   *
   * `app-sidebar.tsx` already models nav icons as `React.ComponentType`; this
   * matches that shape and its `18px` sizing so the two sidebars agree.
   */
  icon: LucideIcon;
}

/**
 * `LayoutGrid` is deliberately the same four-square shape as `DashboardIcon` in
 * `app-sidebar.tsx` — the two sidebars are never on screen together, so the
 * Dashboard entry should be recognisable as the same idea in both.
 */
const links: PlatformNavLink[] = [
  { href: "/platform-admin", label: "Dashboard", icon: LayoutGrid },
  {
    href: "/platform-admin/organizations",
    label: "Organizations",
    icon: Building2,
  },
  { href: "/platform-admin/templates", label: "Templates", icon: LayoutTemplate },
];

export function PlatformSidebar({ user }: PlatformSidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex w-64 flex-col border-r bg-gray-900 text-white p-4 sticky top-0 h-screen overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-lg font-bold">Platform Admin</h1>
        <p className="text-xs text-gray-400 mt-1">Smart Task Allocation</p>
      </div>
      <nav className="flex-1 space-y-1">
        {links.map((link) => {
          const isActive =
            link.href === "/platform-admin"
              ? pathname === "/platform-admin"
              : pathname.startsWith(link.href);
          const Icon = link.icon;

          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-blue-900/40 border-l-2 border-blue-400 font-medium text-blue-300"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200 border-l-2 border-transparent"
              }`}
            >
              {/* Decorative: the label beside it is the accessible name. */}
              <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-gray-700 pt-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs font-medium text-blue-300">
            {user.name?.split(" ").map((n) => n[0]).join("").slice(0, 2) || "PA"}
          </div>
          <div>
            <p className="text-sm font-medium">{user.name}</p>
            <p className="text-xs text-gray-500">{user.email}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full border-gray-600 text-gray-300 hover:bg-gray-800"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          Sign out
        </Button>
      </div>
    </aside>
  );
}