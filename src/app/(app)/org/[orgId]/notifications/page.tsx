/**
 * Notifications Page (Boundary Layer)
 *
 * The full history behind the sidebar bell: everything the user has been told
 * in THIS organisation, filterable by category, searchable, and paginated.
 *
 * Filtering, search and counts are all server-side (see the feed endpoint) —
 * the page holds no notion of "all notifications", only the page it was given
 * plus the totals the API reported.
 *
 * Interaction model:
 * - Clicking a row marks it read and navigates to whatever it is about.
 * - Clicking the unread dot marks it read WITHOUT navigating, so a user can
 *   clear a notification they do not need to act on.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  createdAt: string;
}

interface FeedCounts {
  all: number;
  unread: number;
  task: number;
  assignment: number;
  certification: number;
  alert: number;
}

interface Feed {
  notifications: Notification[];
  total: number;
  hasMore: boolean;
  unreadCount: number;
  todayCount: number;
  needsActionCount: number;
  counts: FeedCounts;
}

type FilterKey = "all" | "unread" | "task" | "assignment" | "certification" | "alert";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "task", label: "Tasks" },
  { key: "assignment", label: "Assignments" },
  { key: "certification", label: "Certifications" },
  { key: "alert", label: "Alerts" },
];

const PAGE_SIZE = 20;

/** Emoji + tint per type. Mirrors the bell so the two never look like different features. */
function iconFor(type: string): { glyph: string; tint: string } {
  switch (type) {
    case "task_assigned":
      return { glyph: "📋", tint: "bg-indigo-500/[.13]" };
    case "task_rescheduled":
      return { glyph: "🔄", tint: "bg-indigo-500/[.13]" };
    case "task_cancelled":
    case "task_unassigned":
      return { glyph: "🚫", tint: "bg-red-500/[.12]" };
    case "task_completed":
    case "assignment_accepted":
      return { glyph: "✅", tint: "bg-green-500/[.13]" };
    case "assignment_rejected":
      return { glyph: "❌", tint: "bg-red-500/[.12]" };
    case "withdrawal_requested":
      return { glyph: "📤", tint: "bg-amber-500/[.14]" };
    case "withdrawal_approved":
      return { glyph: "👍", tint: "bg-green-500/[.13]" };
    case "withdrawal_denied":
      return { glyph: "👎", tint: "bg-red-500/[.12]" };
    case "cert_verified":
      return { glyph: "🏆", tint: "bg-green-500/[.13]" };
    case "cert_rejected":
      return { glyph: "⚠️", tint: "bg-red-500/[.12]" };
    case "hour_limit_warning":
      return { glyph: "⏰", tint: "bg-amber-500/[.14]" };
    case "staff_ineligible":
      return { glyph: "🚧", tint: "bg-amber-500/[.14]" };
    case "org_suspended":
      return { glyph: "🔒", tint: "bg-red-500/[.12]" };
    default:
      return { glyph: "🔔", tint: "bg-muted" };
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  task_assigned: "Task",
  task_unassigned: "Task",
  task_cancelled: "Task",
  task_rescheduled: "Task",
  task_completed: "Task",
  assignment_accepted: "Assignment",
  assignment_rejected: "Assignment",
  withdrawal_requested: "Assignment",
  withdrawal_approved: "Assignment",
  withdrawal_denied: "Assignment",
  cert_verified: "Certification",
  cert_rejected: "Certification",
  hour_limit_warning: "Alert",
  staff_ineligible: "Alert",
  org_suspended: "Alert",
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Buckets a notification by the viewer's local calendar day.
 * Deliberately client-side: "Today" in a date heading should mean the day the
 * person reading it is having, which the browser already knows.
 */
function groupFor(dateStr: string): string {
  const date = new Date(dateStr);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (date >= startOfToday) return "Today";

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfYesterday) return "Yesterday";

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  if (date >= startOfWeek) return "Earlier this week";

  return "Older";
}

function StatTile({
  label,
  value,
  detail,
  accentColour,
  valueColour,
}: {
  label: string;
  value: number;
  detail: string;
  accentColour: string;
  valueColour?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3.5 sm:p-4">
      <div
        className="absolute right-0 top-0 h-10 w-10 rounded-bl-[40px]"
        style={{ background: accentColour }}
      />
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-xl font-bold tracking-tight sm:text-2xl ${valueColour ?? ""}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function NotificationsPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;

  const [feed, setFeed] = useState<Feed | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Guards against a slow early request overwriting a newer one's results. */
  const requestId = useRef(0);

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchFeed = useCallback(
    async (nextOffset: number, append: boolean) => {
      const currentRequest = ++requestId.current;
      if (append) setLoadingMore(true);

      try {
        const query = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
        });
        if (filter === "unread") query.set("unread", "true");
        else if (filter !== "all") query.set("category", filter);
        if (search) query.set("search", search);

        const res = await fetch(
          `/api/organizations/${orgId}/notifications?${query}`
        );
        if (!res.ok) throw new Error("Request failed");

        const data: Feed = await res.json();
        if (currentRequest !== requestId.current) return; // superseded

        setFeed(data);
        setItems((prev) =>
          append ? [...prev, ...data.notifications] : data.notifications
        );
        setOffset(nextOffset);
        setError(null);
      } catch {
        if (currentRequest !== requestId.current) return;
        setError("Failed to load notifications");
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [orgId, filter, search]
  );

  // Refetch from the top whenever the filter or search term changes.
  useEffect(() => {
    setLoading(true);
    fetchFeed(0, false);
  }, [fetchFeed]);

  /** Marks one notification read and reconciles every counter it appears in. */
  async function markRead(notification: Notification) {
    if (notification.isRead || busyIds.includes(notification.id)) return;

    setBusyIds((prev) => [...prev, notification.id]);
    // Optimistic — a read receipt is not worth a spinner.
    setItems((prev) =>
      prev.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n))
    );
    setFeed((prev) =>
      prev
        ? {
            ...prev,
            unreadCount: Math.max(0, prev.unreadCount - 1),
            counts: { ...prev.counts, unread: Math.max(0, prev.counts.unread - 1) },
          }
        : prev
    );

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/notifications/${notification.id}/read`,
        { method: "PATCH" }
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      // Roll back so the badge never disagrees with the database.
      setItems((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, isRead: false } : n))
      );
      setFeed((prev) =>
        prev
          ? {
              ...prev,
              unreadCount: prev.unreadCount + 1,
              counts: { ...prev.counts, unread: prev.counts.unread + 1 },
            }
          : prev
      );
      setError("Could not mark that notification as read");
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== notification.id));
    }
  }

  async function handleRowClick(notification: Notification) {
    void markRead(notification);

    if (!notification.entityType) return;
    switch (notification.entityType) {
      case "task":
        router.push(`/org/${orgId}/tasks`);
        break;
      case "assignment":
        router.push(`/org/${orgId}/my-tasks`);
        break;
      case "certification":
        router.push(`/org/${orgId}/certifications`);
        break;
      case "membership":
        router.push(`/org/${orgId}/members`);
        break;
      default:
        break;
    }
  }

  async function handleMarkAllRead() {
    const previous = items;
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setFeed((prev) =>
      prev ? { ...prev, unreadCount: 0, counts: { ...prev.counts, unread: 0 } } : prev
    );

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/notifications/mark-all-read`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("Request failed");
      // If the user is filtered to Unread, those rows no longer belong here.
      if (filter === "unread") fetchFeed(0, false);
    } catch {
      setItems(previous);
      setError("Could not mark all as read");
      fetchFeed(0, false);
    }
  }

  if (loading && !feed) return <PageLoading />;

  const counts = feed?.counts;
  const countFor = (key: FilterKey) => counts?.[key] ?? 0;

  // Group the loaded rows by day, preserving the server's newest-first order.
  const groups: { label: string; items: Notification[] }[] = [];
  for (const item of items) {
    const label = groupFor(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  const isFiltered = filter !== "all" || search.length > 0;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            Notifications
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Everything that needs your attention, newest first
          </p>
        </div>
        <button
          onClick={handleMarkAllRead}
          disabled={!feed || feed.unreadCount === 0}
          className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-default disabled:opacity-45"
        >
          Mark all as read
        </button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Unread"
          value={feed?.unreadCount ?? 0}
          detail="awaiting your attention"
          accentColour="rgba(99,102,241,.08)"
          valueColour="text-indigo-600 dark:text-indigo-400"
        />
        <StatTile
          label="Today"
          value={feed?.todayCount ?? 0}
          detail="received since midnight"
          accentColour="rgba(34,197,94,.08)"
          valueColour="text-green-600 dark:text-green-400"
        />
        <StatTile
          label="Needs action"
          value={feed?.needsActionCount ?? 0}
          detail="rejections & hour limits"
          accentColour="rgba(245,158,11,.08)"
          valueColour={
            (feed?.needsActionCount ?? 0) > 0
              ? "text-amber-600 dark:text-amber-400"
              : ""
          }
        />
        <StatTile
          label="Total"
          value={feed?.counts.all ?? 0}
          detail="all time"
          accentColour="rgba(148,163,184,.08)"
          valueColour="text-muted-foreground"
        />
      </div>

      {/* ── Filters ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(({ key, label }) => {
          const active = filter === key;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "bg-gradient-to-r from-indigo-600 to-indigo-500 font-semibold text-white shadow-sm"
                  : "border border-border bg-card font-medium text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              <span
                className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${
                  active ? "bg-white/20 text-white" : "bg-muted text-muted-foreground"
                }`}
              >
                {countFor(key)}
              </span>
            </button>
          );
        })}

        <div className="relative sm:ml-auto">
          <svg
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search notifications…"
            aria-label="Search notifications"
            className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-3 text-xs outline-none transition-colors focus:border-indigo-500 sm:w-56"
          />
        </div>
      </div>

      {/* ── Feed ── */}
      {items.length === 0 ? (
        isFiltered ? (
          <EmptyState
            title={
              filter === "unread"
                ? "You're all caught up"
                : "No matching notifications"
            }
          />
        ) : (
          <EmptyState title="No notifications yet" />
        )
      ) : (
        <div className="space-y-5">
          {groups.map((group, groupIndex) => (
            <div key={`${group.label}-${groupIndex}`}>
              <div className="mb-2 flex items-center gap-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {group.items.map((notification) => {
                  const { glyph, tint } = iconFor(notification.type);
                  return (
                    <div
                      key={notification.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleRowClick(notification)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleRowClick(notification);
                        }
                      }}
                      className={`group relative flex w-full cursor-pointer gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 ${
                        notification.isRead
                          ? "hover:bg-muted/50"
                          : "bg-indigo-500/[.055] hover:bg-indigo-500/[.10] dark:bg-indigo-500/[.10]"
                      }`}
                    >
                      {!notification.isRead && (
                        <span className="absolute left-0 top-0 h-full w-[3px] bg-indigo-500" />
                      )}

                      <div
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[15px] ${tint}`}
                        aria-hidden="true"
                      >
                        {glyph}
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-[13.5px] ${
                            notification.isRead ? "font-medium" : "font-semibold"
                          }`}
                        >
                          {notification.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                          {notification.message}
                        </p>
                        <p className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/75">
                          <span className="rounded border border-border px-1.5 text-[9.5px] font-semibold uppercase tracking-wide">
                            {CATEGORY_LABELS[notification.type] ?? "Update"}
                          </span>
                          {timeAgo(notification.createdAt)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2 pt-1">
                        {!notification.isRead && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void markRead(notification);
                            }}
                            disabled={busyIds.includes(notification.id)}
                            title="Mark as read"
                            aria-label={`Mark "${notification.title}" as read`}
                            className="h-2 w-2 shrink-0 rounded-full bg-indigo-500 transition-transform hover:scale-150 disabled:opacity-50"
                          />
                        )}
                        <svg
                          className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60"
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          aria-hidden="true"
                        >
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {feed?.hasMore && (
            <div className="flex justify-center pt-1">
              <button
                onClick={() => fetchFeed(offset + PAGE_SIZE, true)}
                disabled={loadingMore}
                className="rounded-lg border border-border bg-card px-4 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load older notifications"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
