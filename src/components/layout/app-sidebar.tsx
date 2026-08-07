/**
 * App Sidebar Component (Boundary Layer)
 *
 * Role-aware sidebar navigation with branded gradient styling,
 * section-grouped navigation, subscription-based feature gating,
 * and user context display.
 *
 * Displays:
 * - Branded logo with gradient background (indigo-to-violet)
 * - Navigation links grouped into Overview / Organization / System
 * - Notification badge with unread count
 * - User card with avatar initials + role info
 * - Dark mode toggle and sign out
 *
 * Navigation is filtered by role and subscription tier.
 */
"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useTheme } from "@/components/theme-provider";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { getSystemRoleLabel } from "@/lib/role-config";
import type { PermissionName } from "@/lib/permission-guard";

// ============================================================
// SVG icon components
// ============================================================

const iconClass = "w-[18px] h-[18px] shrink-0";

function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function MembersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function DepartmentsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function CertificationsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function NotificationsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function AuditLogIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function RolesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );
}

function WorkRulesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </svg>
  );
}

function AutoScheduleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function AvailabilityIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function MyTasksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

/**
 * An award/medal, deliberately different from the shield used by the org-wide
 * Certifications page. A manager sees both entries, and giving them the same
 * glyph would make the personal list look like a duplicate of the review queue.
 */
function MyCertificationsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <circle cx="12" cy="9" r="6" />
      <path d="M8.2 13.9 7 22l5-3 5 3-1.2-8.1" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function ThemeIcon({ isDark }: { isDark: boolean }) {
  if (isDark) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// ============================================================
// Navigation structure types
// ============================================================

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType;
  badge?: number;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

// ============================================================
// Props
// ============================================================

interface AppSidebarProps {
  user: {
    name: string | null;
    email: string;
  };
  orgId?: string;
  orgName?: string;
  role?: string;
  employmentType?: string;
  customRoleLabel?: string;
  permissions?: string[];
  organizations?: { id: string; name: string; status: string }[];
}

// ============================================================
// Component
// ============================================================

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function AppSidebar({
  user,
  orgId,
  orgName,
  role,
  employmentType,
  customRoleLabel,
  permissions = [],
  organizations = [],
}: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [features, setFeatures] = useState<Record<string, boolean> | null>(null);
  const [tier, setTier] = useState<{ name: string; displayName: string } | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [switchingOrg, setSwitchingOrg] = useState(false);
  const unreadRequestInFlight = useRef(false);
  const can = (permission: PermissionName) => permissions.includes(permission);

  useEffect(() => {
    setMounted(true);
    setCollapsed(window.localStorage.getItem("shifthappens-sidebar-collapsed") === "true");
  }, []);

  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("shifthappens-sidebar-collapsed", String(next));
      return next;
    });
  }

  async function switchOrganization(nextOrgId: string) {
    if (!nextOrgId || nextOrgId === orgId || switchingOrg) return;
    setSwitchingOrg(true);
    try {
      const response = await fetch("/api/organizations/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: nextOrgId }),
      });
      if (!response.ok) throw new Error("Unable to switch organization");
      router.push("/dashboard");
      router.refresh();
    } finally {
      setSwitchingOrg(false);
    }
  }

  // Close sidebar on route change (mobile navigation)
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Fetch subscription features for sidebar gating
  useEffect(() => {
    if (orgId) {
      fetch(`/api/organizations/${orgId}/subscription`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.features) setFeatures(data.features);
          if (data?.tier) setTier({ name: data.tier, displayName: data.displayName });
        })
        .catch(() => {});
    }
  }, [orgId]);

  const fetchUnreadCount = useCallback(async () => {
    if (!orgId || unreadRequestInFlight.current) return;
    unreadRequestInFlight.current = true;
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/notifications/unread-count`
      );
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.count);
      }
    } catch {
      // Non-critical — polling
    } finally {
      unreadRequestInFlight.current = false;
    }
  }, [orgId]);

  // Poll unread notification count.
  // Notifications are org-scoped, so there is nothing to poll outside an org.
  useEffect(() => {
    if (!orgId) {
      setUnreadCount(0);
      return;
    }
    void fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 120000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount, orgId]);

  // Build navigation sections based on role
  const sections: NavSection[] = [];

  // --- Overview section (visible to all) ---
  const overviewItems: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  ];

  if (orgId && role) {
    if (can("tasks:read")) {
      overviewItems.push({ href: `/org/${orgId}/tasks`, label: "Tasks", icon: TasksIcon });
      overviewItems.push({ href: `/org/${orgId}/projects`, label: "Projects", icon: TasksIcon });
    }
    if (can("calendar:view")) {
      overviewItems.push({ href: `/org/${orgId}/calendar`, label: "Calendar", icon: CalendarIcon });
    }
    if (role === "staff") {
      overviewItems.push({ href: `/org/${orgId}/my-tasks`, label: "My Tasks", icon: MyTasksIcon });
      overviewItems.push({ href: `/org/${orgId}/my-calendar`, label: "My Calendar", icon: CalendarIcon });
    }
    if (role === "staff" || role === "manager") {
      overviewItems.push({ href: `/org/${orgId}/availability`, label: "My Availability", icon: AvailabilityIcon });
      // Managers hold certifications too, and the org-wide Certifications page
      // is a review queue for other people's — it has no way to submit one.
      overviewItems.push({ href: `/org/${orgId}/my-certifications`, label: "My Certifications", icon: MyCertificationsIcon });
    }
  }

  sections.push({ title: "Overview", items: overviewItems });

  // --- Organization section (admin + manager) ---
  if (orgId && role) {
    const orgItems: NavItem[] = [];

    if (can("members:read")) {
      orgItems.push({ href: `/org/${orgId}/members`, label: "Members", icon: MembersIcon });
    }
    if (can("departments:read")) {
      orgItems.push({ href: `/org/${orgId}/departments`, label: "Departments", icon: DepartmentsIcon });
    }
    if (can("certifications:read")) {
      orgItems.push({ href: `/org/${orgId}/certifications`, label: role === "manager" ? "Certification Review" : "Certification Requirements", icon: CertificationsIcon });
    }

    if (can("roles:read")) {
      // Roles: only show if custom_roles feature is available (Pro+)
      if (features === null || features.custom_roles !== false) {
        orgItems.push({ href: `/org/${orgId}/roles`, label: "Roles", icon: RolesIcon });
      }
    }
    if (can("work_rules:read")) {
      orgItems.push({ href: `/org/${orgId}/work-rules`, label: "Work Rules", icon: WorkRulesIcon });
    }
    if (can("schedule:generate")) {
      orgItems.push({ href: `/org/${orgId}/auto-schedule`, label: "Schedule Review", icon: AutoScheduleIcon });
    }

    if (orgItems.length > 0) sections.push({ title: "Organization", items: orgItems });
  }

  // --- System section ---
  const systemItems: NavItem[] = [];

  if (orgId) {
    systemItems.push({
      href: `/org/${orgId}/notifications`,
      label: "Notifications",
      icon: NotificationsIcon,
      badge: unreadCount > 0 ? unreadCount : undefined,
    });
  }

  if (orgId && can("audit:view")) {
    // Audit Log: show when the Pro-or-higher audit feature is available.
    if (features === null || features.audit_log !== false) {
      systemItems.push({ href: `/org/${orgId}/audit-log`, label: "Audit Log", icon: AuditLogIcon });
    }
  }
  if (orgId && can("settings:read")) {
    systemItems.push({ href: `/org/${orgId}/settings`, label: "Settings", icon: SettingsIcon });
  }

  systemItems.push({ href: "/settings/profile", label: "Profile", icon: ProfileIcon });

  sections.push({ title: "System", items: systemItems });

  // User initials
  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user.email[0].toUpperCase();

  const roleLabel = role ? getSystemRoleLabel(role, employmentType) : undefined;

  return (
    <>
      {/* Mobile hamburger button — visible only on small screens */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-40 flex h-10 w-10 items-center justify-center rounded-lg text-white shadow-lg md:hidden"
        style={{ background: "linear-gradient(135deg, #4338ca, #5b21b6)" }}
        aria-label="Open menu"
      >
        <HamburgerIcon />
      </button>

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside className={`app-sidebar ${collapsed ? "app-sidebar-collapsed" : ""} ${mobileOpen ? "app-sidebar-mobile-open" : ""}`}>
        {/* Mobile close button */}
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-5 right-4 z-[2] flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white md:hidden"
          aria-label="Close menu"
        >
          <CloseIcon />
        </button>

        {/* Dot-grid overlay */}
        <div className="app-sidebar-dots" aria-hidden="true" />

      {/* Logo */}
      <div className="app-sidebar-brand relative z-[1] mb-9 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white/20 text-sm font-extrabold backdrop-blur-sm">
          {(orgName || "S")[0].toUpperCase()}
        </div>
        <div className="app-sidebar-brand-copy flex flex-col gap-0.5">
          <span className="text-[15px] font-bold tracking-tight">{orgName || "Smart Task"}</span>
          {organizations.length > 1 && !collapsed && (
            <label className="sr-only" htmlFor="organization-switcher">Organization</label>
          )}
          {organizations.length > 1 && !collapsed && (
            <select
              id="organization-switcher"
              value={orgId}
              disabled={switchingOrg}
              onChange={(event) => void switchOrganization(event.target.value)}
              className="mt-1 max-w-[11rem] rounded-md border border-white/20 bg-white/10 px-1.5 py-1 text-[11px] text-white"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id} className="text-slate-900">
                  {organization.name}{organization.status !== "active" ? " (suspended)" : ""}
                </option>
              ))}
            </select>
          )}
          {tier && (
            <span className="w-fit rounded-full bg-white/15 px-2 py-px text-[10px] font-semibold text-white/80">
              {tier.displayName}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={toggleSidebar}
          className="app-sidebar-collapse-button ml-auto hidden h-8 w-8 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white md:flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="relative z-[1] flex-1">
        {sections.map((section, sectionIdx) => (
          <div key={section.title}>
            <div
              className={`mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.08em] text-white/35 ${
                sectionIdx === 0 ? "mt-0" : "mt-5"
              }`}
            >
              {section.title}
            </div>
            {section.items.map((item) => {
              const isActive =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`app-sidebar-link ${isActive ? "app-sidebar-link-active" : ""}`}
                  title={collapsed ? item.label : undefined}
                >
                  <span className={isActive ? "opacity-100" : "opacity-70"}>
                    <Icon />
                  </span>
                  <span className="app-sidebar-item-label flex-1">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="app-sidebar-item-badge flex min-w-[18px] items-center justify-center rounded-[9px] bg-red-500/90 px-[5px] text-[10px] font-bold text-white" style={{ height: 18 }}>
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="relative z-[1] mt-auto border-t border-white/10 pt-3">
        {/* Theme toggle */}
        {mounted && (
          <button
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="app-sidebar-action-btn"
          title={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <span className="opacity-60">
              <ThemeIcon isDark={resolvedTheme === "dark"} />
            </span>
            <span className="app-sidebar-action-label">{resolvedTheme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
        )}

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="app-sidebar-action-btn"
          title="Sign out"
        >
          <span className="opacity-60">
            <SignOutIcon />
          </span>
          <span className="app-sidebar-action-label">Sign out</span>
        </button>

        {/* User card */}
        <div className="app-sidebar-user-card mt-3 flex items-center gap-2.5 rounded-xl bg-white/10 p-3">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-white/20 text-[13px] font-bold">
            {initials}
          </div>
          <div className="app-sidebar-user-copy min-w-0">
            <div className="truncate text-[13px] font-semibold">
              {user.name || "User"}
            </div>
            <div className="truncate text-xs text-white/50">
              {customRoleLabel || roleLabel || orgName || user.email}
            </div>
          </div>
        </div>
      </div>
    </aside>
    </>
  );
}
