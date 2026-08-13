/**
 * Platform Admin Sidebar (Boundary Layer)
 *
 * The same piece of furniture as `app-sidebar.tsx`, in slate instead of indigo.
 *
 * ## Why it looks different, and why that is deliberate
 *
 * Platform admin spans every tenant, so it should not wear any single
 * organisation's colour — you should be able to tell from across the room that
 * the thing you are about to suspend is not your own company. That was the
 * original intent behind making this sidebar dark.
 *
 * What was wrong was not the colour but everything around it. This panel had
 * its own width, its own link shape, its own footer, a shadcn `Button` where
 * the app uses a flat action row, and — the part that actually broke — **no
 * mobile handling at all**. `app-sidebar` collapses to an overlay drawer below
 * 768px; this one stayed a fixed 256px column, so on a phone a third of the
 * screen was navigation and the page beside it was squeezed into what was left.
 * That is what made the section read as unfinished rather than as distinct.
 *
 * It now shares `.app-sidebar` — width, padding, sticky behaviour, dot grid,
 * pill links, action rows, and the drawer — and overrides only the gradient,
 * through `--sidebar-gradient` on `.app-sidebar-platform`. A change to the
 * sidebar's shape now lands in both places, which is the whole point.
 *
 * ## Two smaller things brought into line
 *
 * There was no theme toggle here, so a platform admin could not switch to dark
 * mode without going back to an org page. There is one now, in the same place.
 *
 * The nav marks were emoji before (`📊 🏢 📋`) — worst here of anywhere, since
 * this panel is permanently dark and an emoji is an OS colour bitmap that
 * cannot inherit `currentColor`. They stayed full-colour while their labels
 * moved between grey, hover-grey and active, and did not dim with inactive
 * items. They are `lucide` components, sized to match `app-sidebar`.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import {
  Building2,
  LayoutGrid,
  LayoutTemplate,
  LogOut,
  Menu,
  Moon,
  ShieldCheck,
  Sun,
  X,
  type LucideIcon,
  MessagesSquare,
  HelpCircle,
  Stars,
} from "lucide-react";

interface PlatformSidebarProps {
  user: {
    name: string | null;
    email: string;
  };
}

interface PlatformNavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * `LayoutGrid` is deliberately the same four-square shape as the Dashboard mark
 * in `app-sidebar.tsx` — the two sidebars are never on screen together, so the
 * entry should read as the same idea in both.
 */
const links: PlatformNavLink[] = [
  { href: "/platform-admin", label: "Dashboard", icon: LayoutGrid },
  {
    href: "/platform-admin/organizations",
    label: "Organizations",
    icon: Building2,
  },
  { href: "/platform-admin/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/platform-admin/feedback", label: "Feedback", icon: MessagesSquare },
  { href: "/platform-admin/faq", label: "FAQ", icon: HelpCircle },
  { href: "/platform-admin/reviews", label: "Reviews", icon: Stars },
];

export function PlatformSidebar({ user }: PlatformSidebarProps) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: marks the client as mounted so theme-dependent markup matches the server render
    setMounted(true);
  }, []);

  /** Close the drawer on navigation, or it stays open over the new page. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: dismisses the mobile drawer when the route changes
    setMobileOpen(false);
  }, [pathname]);

  const initials =
    user.name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <>
      {/* Mobile hamburger — small screens only */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-40 flex h-10 w-10 items-center justify-center rounded-lg text-white shadow-lg md:hidden"
        style={{ background: "linear-gradient(135deg, #0f172a, #1e293b)" }}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`app-sidebar app-sidebar-platform ${
          mobileOpen ? "app-sidebar-mobile-open" : ""
        }`}
      >
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute right-4 top-5 z-[2] flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white md:hidden"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="app-sidebar-dots" aria-hidden="true" />

        {/* Brand */}
        <div className="relative z-[1] mb-9 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white/20 backdrop-blur-sm">
            <ShieldCheck className="h-[18px] w-[18px]" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-bold tracking-tight">
              Platform Admin
            </span>
            <span className="w-fit rounded-full bg-white/15 px-2 py-px text-xs font-semibold text-white/80">
              All tenants
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="relative z-[1] flex-1">
          <div className="mb-1.5 px-3 text-xs font-bold uppercase tracking-[0.08em] text-white/35">
            Manage
          </div>
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
                aria-current={isActive ? "page" : undefined}
                className={`app-sidebar-link ${isActive ? "app-sidebar-link-active" : ""}`}
              >
                {/* Decorative: the label beside it is the accessible name. */}
                <Icon
                  className={`h-[18px] w-[18px] shrink-0 ${
                    isActive ? "opacity-100" : "opacity-70"
                  }`}
                  aria-hidden="true"
                />
                <span className="flex-1">{link.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="relative z-[1] mt-auto border-t border-white/10 pt-3">
          {mounted && (
            <button
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              className="app-sidebar-action-btn"
              title={
                resolvedTheme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
            >
              {resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
              )}
              <span>{resolvedTheme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          )}

          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="app-sidebar-action-btn"
          >
            <LogOut className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
            <span>Sign out</span>
          </button>

          <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-white/10 p-3">
            <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {user.name || "Platform admin"}
              </div>
              <div className="truncate text-xs text-white/50">{user.email}</div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
