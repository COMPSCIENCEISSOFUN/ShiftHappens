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
 * Navigation is filtered by the caller's effective PERMISSIONS and by
 * subscription tier — see the comment above the section builders.
 */
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { getSystemRoleLabel, canBeRostered } from "@/lib/role-config";
import { usePlan } from "@/components/layout/plan-provider";

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

/** A calendar with a cross through it — a day struck out. */
function LeaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="10" y1="14" x2="14" y2="18" />
      <line x1="14" y1="14" x2="10" y2="18" />
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

/**
 * A calendar with a person, for the member's own week.
 *
 * Deliberately NOT the same glyph as the team `CalendarIcon` above: they sit
 * three items apart in the same menu and answer different questions — "what is
 * everyone doing" versus "what am I doing" — so two identical calendars would
 * make the pair look like a duplicate entry.
 */
function MyScheduleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <circle cx="12" cy="15" r="2" />
      <path d="M9 19a3 3 0 0 1 6 0" />
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
 * A clock with an arrow turning back — the conventional "history" glyph, and
 * deliberately not the plain clock used elsewhere in this file for scheduling.
 * The two sit in the same menu and must not read as the same idea.
 */
function MyHistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={iconClass}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
      <polyline points="12 7 12 12 15 14" />
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
  /**
   * Every organisation the caller belongs to, for the switcher.
   *
   * Optional and usually absent: only `org/[orgId]/layout.tsx` passes it,
   * because only a page that already knows which organisation it is in can
   * offer to leave it. Omitted, or holding one entry, the name renders as
   * plain text — a menu with a single item is a menu that lies about having a
   * choice in it.
   */
  organizations?: { id: string; name: string }[];
  role?: string;
  employmentType?: string;
  customRoleLabel?: string;
  /** The caller's effective permissions — see the nav comment below. */
  permissions?: string[];
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

/** The initial tile. Identical in both branches, so it lives in one place. */
function OrgMark({ name }: { name?: string }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/20 text-sm font-extrabold backdrop-blur-sm">
      {(name || "S")[0].toUpperCase()}
    </div>
  );
}

/**
 * Name above plan, in one column.
 *
 * `min-w-0` on the column and `truncate` on the name: without both, a long
 * organisation name pushes the caret off the edge of a fixed-width sidebar
 * rather than shortening itself.
 */
function OrgIdentity({
  orgName,
  tierName,
}: {
  orgName?: string;
  /** Null where a plan is not a fact — onboarding has no organisation yet. */
  tierName: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
      <span className="w-full truncate text-[15px] font-bold tracking-tight">
        {orgName}
      </span>
      {tierName && (
        <span className="rounded-full bg-white/15 px-2 py-px text-[10px] font-semibold text-white/80">
          {tierName}
        </span>
      )}
    </div>
  );
}

export function AppSidebar({
  user,
  orgId,
  orgName,
  organizations = [],
  role,
  employmentType,
  customRoleLabel,
  permissions = [],
}: AppSidebarProps) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingLeaveCount, setPendingLeaveCount] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  async function fetchUnreadCount() {
    if (!orgId) return;
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
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: marks the client as mounted so theme-dependent markup matches the server render
    setMounted(true);
  }, []);

  // Close sidebar on route change (mobile navigation)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: closes the mobile drawer when the route changes
    setMobileOpen(false);
  }, [pathname]);

  /*
   * The plan, read rather than fetched.
   *
   * This used to request `/subscription` on mount and treat "not answered yet"
   * as "allowed", so Roles and Audit Log appeared in the menu on every page
   * load and then disappeared once the answer arrived — a link the reader could
   * see, and sometimes click, that was never theirs. The tier now arrives from
   * the server with the rest of the chrome, so the first paint is the right
   * one and a request per page load goes away with it.
   */
  const { has: planHas, tierName } = usePlan();

  /*
   * Poll the count of leave awaiting a decision.
   *
   * Gated on the permission before the request is made, not after. The endpoint
   * is manager-only, so an unconditional poll would give every staff member a
   * 403 in their console every thirty seconds — and the item is hidden from
   * them anyway, so the answer could not be used.
   */
  async function fetchPendingLeaveCount() {
    if (!orgId) return;
    try {
      const res = await fetch(`/api/organizations/${orgId}/leave`);
      const data = await res.json();
      setPendingLeaveCount(res.ok && Array.isArray(data) ? data.length : 0);
    } catch {
      /* non-critical — the badge simply does not appear */
    }
  }

  // Poll unread notification count.
  // Notifications are org-scoped, so there is nothing to poll outside an org.
  useEffect(() => {
    if (!orgId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: polls the unread count, and resets it on leaving an organisation
      setUnreadCount(0);
      return;
    }
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [orgId]);

  // Same cadence as the notification bell, for the same reason: a badge that
  // only updates on navigation is a badge somebody has already stopped
  // believing.
  useEffect(() => {
    if (!orgId || !permissions.includes("members:request_availability")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: resets the badge on leaving an organisation or losing the permission
      setPendingLeaveCount(0);
      return;
    }
    fetchPendingLeaveCount();
    const interval = setInterval(fetchPendingLeaveCount, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, permissions]);


  /*
   * The menu is built from PERMISSIONS, not from the role string.
   *
   * It used to read `role === "company_admin" || role === "manager"`, which
   * meant a custom role changed what the API would allow without changing what
   * the user was offered — in both directions. A "Shift Lead" granted
   * `tasks:assign` never saw the Tasks link; a manager whose custom role
   * withheld `reports:view` still saw Reports and met a 403 on arrival.
   *
   * Every entry below names the permission its destination actually enforces,
   * so a visible link always leads somewhere the user may go. Personal pages —
   * their own shifts, availability and certificates — carry no permission,
   * because being an active member is what grants those.
   */
  const held = new Set(permissions);
  /*
   * More than one organisation AND a current one to switch away from.
   *
   * The `orgId` half matters: the org-agnostic chrome has no current
   * organisation, so a switcher there would be a list with nothing marked as
   * where you are.
   */
  const canSwitchOrg = Boolean(orgId) && organizations.length > 1;

  const can = (permission: string) => held.has(permission);
  const canAny = (...candidates: string[]) => candidates.some(can);

  const sections: NavSection[] = [];

  // --- Overview section ---
  const overviewItems: NavItem[] = [
    /*
     * The dashboard OF THIS ORGANISATION, when the sidebar knows which one.
     *
     * This was `/dashboard` unconditionally, which resolved to the user's
     * oldest organisation — so a member of two who was standing inside
     * organisation B, reading B's members and B's rota, pressed Dashboard and
     * landed on A. The rest of the menu below has always been org-scoped; this
     * one entry was not, and it was the entry people press most.
     *
     * The bare `/dashboard` remains for the org-agnostic chrome, where it does
     * the redirect it now exists to do.
     */
    {
      href: orgId ? `/org/${orgId}/dashboard` : "/dashboard",
      label: "Dashboard",
      icon: DashboardIcon,
    },
  ];

  if (orgId) {
    // The management view. Any one of the shift powers is reason to be here —
    // a role that may assign but not create still needs the page.
    if (canAny("tasks:create", "tasks:update", "tasks:delete", "tasks:assign")) {
      overviewItems.push({ href: `/org/${orgId}/tasks`, label: "Tasks", icon: TasksIcon });
    }
    if (can("calendar:view_team")) {
      overviewItems.push({ href: `/org/${orgId}/calendar`, label: "Calendar", icon: CalendarIcon });
    }

    /*
     * Personal pages — for anyone who can actually be put on a shift.
     *
     * Not a permission, and deliberately not `role === "staff"` either.
     *
     * "My Tasks" was shown only to staff, so a MANAGER assigned to a shift had
     * nowhere to accept it: the page existed and was reachable by URL, but
     * nothing linked them to it. Fixing that by making all three unconditional
     * overshot in the other direction and began offering them to admins, who
     * are excluded from rostering in three separate places — the eligibility
     * engine, `assignStaff`, and `findSchedulableStaff`. All three pages are
     * permanently empty for them, and availability and certifications only feed
     * an eligibility check they are never part of.
     *
     * `canBeRostered` is the same predicate those three now share, so the menu
     * cannot drift from what the engine will consider.
     */
    if (canBeRostered(role)) {
      overviewItems.push({ href: `/org/${orgId}/my-tasks`, label: "My Tasks", icon: MyTasksIcon });
      /*
       * The same shifts as a week rather than a list — for the people who have
       * no other calendar.
       *
       * A list answers "what am I on next"; a grid answers "what does my week
       * look like" — where the gaps are, whether two shifts are back to back —
       * and no ordering of a list produces that.
       *
       * `!can("calendar:view_team")` because a MANAGER is rostered AND can open
       * the team calendar, so they were offered two calendars drawing the same
       * week: this one, and Calendar with their own shifts somewhere among
       * everyone else's. Only the manager saw the duplication — staff cannot
       * open Calendar, and an admin is not rostered.
       *
       * The subtraction is only safe because Calendar now carries a Mine
       * toggle. Without it, taking this away would remove the one view that
       * answers "what does MY week look like" from the people most likely to be
       * working a shift and running the floor at the same time. The PAGE stays
       * either way; this is about how many calendars appear in a menu.
       */
      if (!can("calendar:view_team")) {
        overviewItems.push({ href: `/org/${orgId}/my-schedule`, label: "My Schedule", icon: MyScheduleIcon });
      }
      // The record of finished shifts, which My Tasks deliberately keeps short:
      // that page answers "am I on tonight", this one answers "what have I
      // worked". Same `canBeRostered` gate as the rest of this group.
      overviewItems.push({ href: `/org/${orgId}/my-history`, label: "My History", icon: MyHistoryIcon });
      overviewItems.push({ href: `/org/${orgId}/availability`, label: "My Availability", icon: AvailabilityIcon });
      // The org-wide Certifications page is a review queue for other people's;
      // it has no way to submit one of your own.
      overviewItems.push({ href: `/org/${orgId}/my-certifications`, label: "My Certifications", icon: MyCertificationsIcon });
    }
  }

  sections.push({ title: "Overview", items: overviewItems });

  // --- Organization section ---
  if (orgId) {
    const orgItems: NavItem[] = [];

    /*
     * `members:update_seniority` and `members:request_availability` belong in
     * this list. A DEFAULT manager holds those two and none of the other three,
     * so the members page — the only screen exposing the seniority control the
     * seniority route was written for — was unlinked for exactly the role it
     * was built for.
     */
    if (
      canAny(
        "members:invite",
        "members:update_role",
        "members:deactivate",
        "members:update_seniority",
        "members:request_availability"
      )
    ) {
      orgItems.push({ href: `/org/${orgId}/members`, label: "Members", icon: MembersIcon });
    }
    /*
     * Departments was shown to managers, who hold none of these — so the link
     * led to a page whose every button was hidden from them. The list itself is
     * available where it is useful: the task filters and the member list.
     */
    if (canAny("departments:create", "departments:update", "departments:delete")) {
      orgItems.push({ href: `/org/${orgId}/departments`, label: "Departments", icon: DepartmentsIcon });
    }
    if (can("certifications:review")) {
      orgItems.push({ href: `/org/${orgId}/certifications`, label: "Certifications", icon: CertificationsIcon });
    }
    // Tier AND permission. Both can only deny, and the plan is checked first
    // for the same reason the route guard checks it first.
    if (can("roles:manage") && planHas("custom_roles")) {
      orgItems.push({ href: `/org/${orgId}/roles`, label: "Roles", icon: RolesIcon });
    }
    if (can("work_rules:manage")) {
      orgItems.push({ href: `/org/${orgId}/work-rules`, label: "Work Rules", icon: WorkRulesIcon });
    }
    if (can("allocation:auto_schedule")) {
      orgItems.push({ href: `/org/${orgId}/auto-schedule`, label: "Auto-Schedule", icon: AutoScheduleIcon });
    }

    if (orgItems.length > 0) {
      sections.push({ title: "Organization", items: orgItems });
    }
  }

  // --- System section ---
  const systemItems: NavItem[] = [];

  /*
   * Leave requests, for the people who can answer them.
   *
   * A nav item rather than only a dashboard card, because they fail
   * differently: a card is scrolled past, a badge stays until the work is done.
   * Hidden entirely without the permission, so staff never see a link to a page
   * that would refuse them.
   */
  if (orgId && can("members:request_availability")) {
    systemItems.push({
      href: `/org/${orgId}/leave`,
      label: "Leave requests",
      icon: LeaveIcon,
      badge: pendingLeaveCount > 0 ? pendingLeaveCount : undefined,
    });
  }

  if (orgId) {
    systemItems.push({
      href: `/org/${orgId}/notifications`,
      label: "Notifications",
      icon: NotificationsIcon,
      badge: unreadCount > 0 ? unreadCount : undefined,
    });
  }

  if (orgId) {
    if (can("audit:view") && planHas("audit_log")) {
      systemItems.push({ href: `/org/${orgId}/audit-log`, label: "Audit Log", icon: AuditLogIcon });
    }
    if (can("settings:read")) {
      systemItems.push({ href: `/org/${orgId}/settings`, label: "Settings", icon: SettingsIcon });
    }
  }

  /*
   * Your profile, and — when the sidebar knows which organisation it is —
   * the copy of it that lives INSIDE that organisation.
   *
   * The same screen either way; `GET /api/profile` is org-agnostic and always
   * has been. What differs is where you land. `/settings/profile` sits outside
   * the `/org/[orgId]` subtree, so the chrome there has no id to answer "which
   * organisation" from: it used to guess the oldest, and once that guess was
   * removed it honestly answered "none" — which emptied this menu and left the
   * Dashboard link pointing back at the organisation picker. Opening your own
   * profile is not a reason to be thrown out of the organisation you were in.
   *
   * The bare address stays for the person with no organisation at all, who is
   * the only one for whom it is the right answer.
   */
  systemItems.push({
    href: orgId ? `/org/${orgId}/profile` : "/settings/profile",
    label: "Profile",
    icon: ProfileIcon,
  });

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

      <aside className={`app-sidebar ${mobileOpen ? "app-sidebar-mobile-open" : ""}`}>
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

      {/*
        The organisation header, and — for anyone in more than one — the
        switcher.

        ## Why the whole header is the control

        The first version made only the NAME a button and drew a border round
        it. That fixed discoverability and created two new problems: the box sat
        inside a row it did not fill, so its edges lined up with nothing, and
        the plan badge underneath was left hanging off a border that started
        three pixels to its left. It read as tight and slightly crooked because
        it was.

        A workspace switcher is the whole identity block — mark, name, plan —
        with the caret at the far end. That is what every product with one does,
        and the reason is structural rather than fashionable: there is one box,
        so there is one thing to align, and the hit area is the size of the
        thing it represents rather than the size of one word.

        ## Both branches share a layout

        The switchable and non-switchable versions render the same padding and
        the same rows, so the header does not visibly shift depending on how
        many organisations you happen to belong to. Only the caret and the hover
        appear — which is the honest difference between them.
      */}
      <div className="relative z-[1] mb-9 -mx-2">
        {canSwitchOrg ? (
          <button
            type="button"
            onClick={() => setSwitcherOpen((open) => !open)}
            aria-expanded={switcherOpen}
            aria-label={`Switch organisation. Currently ${orgName}`}
            title="Switch organisation"
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
          >
            <OrgMark name={orgName} />
            <OrgIdentity orgName={orgName} tierName={orgId ? tierName : null} />
            {/*
              From the house icon set, not drawn here.

              This file predates `no-inline-icons` and carries several
              hand-written glyphs — and the scan only walks `src/app`, so it is
              exempt by geography rather than by decision. Adding a 47th would
              be taking advantage of that.
            */}
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 shrink-0 text-white/60 transition-transform ${
                switcherOpen ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <div className="flex w-full items-center gap-2.5 px-2 py-2">
            <OrgMark name={orgName} />
            <OrgIdentity
              orgName={orgName || "Smart Task"}
              tierName={orgId ? tierName : null}
            />
          </div>
        )}

        {/*
          Every organisation, including the current one.

          Listing only the OTHERS would save a row and cost the reader the thing
          a menu is for: seeing where they are among the alternatives. The
          current entry is marked and not a link, so pressing it cannot produce
          a navigation that appears to do nothing.

          Each destination is that organisation's dashboard rather than the
          equivalent of the current page. Switching to an organisation where you
          are staff while standing on Work Rules would otherwise land you on a
          page you cannot open, and the honest answer to "take me to the other
          organisation" is its front door.
        */}
        {canSwitchOrg && switcherOpen && (
          <ul className="mt-1 space-y-0.5 rounded-xl bg-black/25 p-1.5">
            {organizations.map((candidate) =>
              candidate.id === orgId ? (
                <li
                  key={candidate.id}
                  className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold text-white"
                >
                  <span className="truncate">{candidate.name}</span>
                  <span className="shrink-0 text-[10px] font-normal text-white/50">
                    current
                  </span>
                </li>
              ) : (
                <li key={candidate.id}>
                  <Link
                    href={`/org/${candidate.id}/dashboard`}
                    onClick={() => {
                      setSwitcherOpen(false);
                      setMobileOpen(false);
                    }}
                    className="block truncate rounded-lg px-3 py-2 text-[13px] text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
                  >
                    {candidate.name}
                  </Link>
                </li>
              )
            )}
          </ul>
        )}
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
                >
                  <span className={isActive ? "opacity-100" : "opacity-70"}>
                    <Icon />
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="flex min-w-[18px] items-center justify-center rounded-[9px] bg-red-500/90 px-[5px] text-[10px] font-bold text-white" style={{ height: 18 }}>
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
            <span>{resolvedTheme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
        )}

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="app-sidebar-action-btn"
        >
          <span className="opacity-60">
            <SignOutIcon />
          </span>
          <span>Sign out</span>
        </button>

        {/* User card */}
        <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-white/10 p-3">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-white/20 text-[13px] font-bold">
            {initials}
          </div>
          <div className="min-w-0">
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
