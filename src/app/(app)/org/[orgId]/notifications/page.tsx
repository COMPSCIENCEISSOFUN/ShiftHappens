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
import { NotificationIconBadge } from "@/components/ui/notification-icon";
import { useParams, useRouter } from "next/navigation";
import { BellOff, CheckCheck, ChevronRight, Search, SearchX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import {
  NOTIFICATION_LABELS,
  type NotificationType,
} from "@/lib/notification-types";
import { notificationHref } from "@/lib/notification-links";
import { usePermissions } from "@/components/layout/permission-provider";

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
  /** ISO instant the organisation's day began — see `groupFor`. */
  todayStart: string;
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

/** Lower-case nouns for the "No ___ yet" empty state. */
const FILTER_NOUNS: Record<FilterKey, string> = {
  all: "notifications",
  unread: "unread notifications",
  task: "task notifications",
  assignment: "assignment updates",
  certification: "certification updates",
  alert: "alerts",
};


/*
 * The badge label map used to be written out here, covered twenty of the
 * twenty-five types, and fell back to "Update" for the rest — so a
 * `leave_approved` row sat under the Assignments pill wearing a badge that said
 * "Update". It now comes from `lib/notification-types`, as a `Record` over the
 * type union, so a new type without a label fails the build rather than
 * quietly rendering as "Update".
 */

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
 * Buckets a notification by the organisation's day, not the browser's.
 *
 * This used to take the reader's local midnight, on the reasoning that "Today"
 * should mean the day the person reading it is having. Defensible on its own —
 * and the "Today" TILE above the list counts against the organisation's
 * timezone, so for anybody outside it the two described different sets. A
 * notification could sit under the "Yesterday" heading while being counted in
 * the "Today" number, which reads as a broken page rather than as two
 * defensible definitions.
 *
 * The boundary now comes from the server, which is the only way the count and
 * the headings can agree by construction rather than by both being changed at
 * the same time.
 */
function groupFor(dateStr: string, todayStart: string): string {
  const date = new Date(dateStr);
  const startOfToday = new Date(todayStart);

  if (date >= startOfToday) return "Today";

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfYesterday) return "Yesterday";

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  if (date >= startOfWeek) return "Earlier this week";

  return "Older";
}


export default function NotificationsPage() {
  const { can } = usePermissions();
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;

  const [feed, setFeed] = useState<Feed | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
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

  /**
   * Load a page.
   *
   * `after` is the last row already on screen, and its presence is what makes
   * this "load older" rather than "reload". Offset paging asked for rows 20–39
   * of a list that grows at the head, so three notifications arriving while you
   * read shifted everything down three places — re-appending rows already shown
   * and skipping three that were never shown at all. On a page whose job is
   * "have I missed anything", losing rows is the wrong failure.
   */
  const fetchFeed = useCallback(
    async (after: Notification | null, append: boolean) => {
      const currentRequest = ++requestId.current;
      if (append) setLoadingMore(true);

      try {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (after) {
          query.set("beforeCreatedAt", new Date(after.createdAt).toISOString());
          query.set("beforeId", after.id);
        }
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
        /*
         * Deduped on append anyway. The cursor makes an overlap impossible in
         * the ordinary case, but two "load older" clicks can still race, and a
         * duplicate key in a React list is a rendering bug rather than a
         * cosmetic one.
         */
        setItems((prev) => {
          if (!append) return data.notifications;
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...data.notifications.filter((n) => !seen.has(n.id))];
        });
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: refetches the feed when the filter or search term changes
    setLoading(true);
    fetchFeed(null, false);
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

    /*
     * One resolver, shared with the bell.
     *
     * This was a switch on `entityType` and the bell had its own, written
     * separately — so they had drifted apart in both directions, and neither
     * had a case for `availability` at all, leaving four leave notifications
     * unclickable. Keying on the TYPE also lets "leave requested" and "leave
     * approved" go to different pages, which `entityType` cannot express since
     * both carry "availability".
     *
     * `can` is passed in so the destination is chosen against the same
     * permissions the destination page will check a moment later.
     */
    const href = notificationHref(notification.type, orgId, can);
    if (href) router.push(href);
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
      if (filter === "unread") fetchFeed(null, false);
    } catch {
      setItems(previous);
      setError("Could not mark all as read");
      fetchFeed(null, false);
    }
  }

  if (loading && !feed) return <PageLoading />;

  const counts = feed?.counts;
  const countFor = (key: FilterKey) => counts?.[key] ?? 0;

  /*
   * Falls back to the browser's midnight only before the first response has
   * landed, when there is nothing to group anyway. Defaulting to it permanently
   * would quietly reinstate the mismatch this exists to remove.
   */
  const todayStart =
    feed?.todayStart ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  // Group the loaded rows by day, preserving the server's newest-first order.
  const groups: { label: string; items: Notification[] }[] = [];
  for (const item of items) {
    const label = groupFor(item.createdAt, todayStart);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
            Notifications
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Everything that needs your attention, newest first
          </p>
        </div>
        <button
          onClick={handleMarkAllRead}
          disabled={!feed || feed.unreadCount === 0}
          className={PRIMARY_BUTTON}
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
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Pills scroll horizontally rather than wrapping — six of them would
            otherwise stack into three rows on a phone, pushing the feed off
            screen. Same treatment as the tasks page. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
          {FILTERS.map(({ key, label }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${
                  active
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-300"
                    : "border-border bg-card text-muted-foreground hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-indigo-600 dark:hover:text-indigo-400"
                }`}
              >
                {label}
                <span
                  className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1 py-0 text-xs font-bold ${
                    active
                      ? "bg-indigo-600 text-white dark:bg-indigo-500"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {countFor(key)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative shrink-0 sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search notifications..."
            aria-label="Search notifications"
            className="h-9 pl-9 text-sm"
          />
        </div>
      </div>

      {/* ── Feed ── */}
      {items.length === 0 ? (
        // Three distinct empty states. "Nothing has ever happened" and "nothing
        // matches what you just typed" are completely different situations, and
        // a single generic message leaves the user unsure which one they are in.
        filter === "unread" ? (
          <EmptyState
            icon={CheckCheck}
            title="You're all caught up"
            description="No unread notifications. Everything here has been read."
            action={
              <button
                onClick={() => setFilter("all")}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                View all notifications
              </button>
            }
          />
        ) : search ? (
          <EmptyState
            icon={SearchX}
            title="No notifications match your search"
            description={`Nothing found for "${search}". Try a shorter word, or check a different category.`}
            action={
              <button
                onClick={() => setSearchInput("")}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear search
              </button>
            }
          />
        ) : filter !== "all" ? (
          <EmptyState
            icon={BellOff}
            title={`No ${FILTER_NOUNS[filter]} yet`}
            description="Nothing in this category so far. Other categories may still have activity."
            action={
              <button
                onClick={() => setFilter("all")}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                View all notifications
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={BellOff}
            title="No notifications yet"
            description="When you're assigned a task, or a colleague responds to one, or a certification is reviewed, it will appear here."
          />
        )
      ) : (
        <div className="space-y-5">
          {groups.map((group, groupIndex) => (
            <div key={`${group.label}-${groupIndex}`}>
              <div className="mb-2 flex items-center gap-2.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {group.items.map((notification) => {
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

                      <NotificationIconBadge
                        type={notification.type}
                        className="mt-0.5 h-9 w-9"
                      />

                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-sm ${
                            notification.isRead ? "font-medium" : "font-semibold"
                          }`}
                        >
                          {notification.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                          {notification.message}
                        </p>
                        <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground/75">
                          <span className="rounded border border-border px-1.5 text-[9.5px] font-semibold uppercase tracking-wide">
                            {NOTIFICATION_LABELS[notification.type as NotificationType] ?? "Update"}
                          </span>
                          {timeAgo(notification.createdAt)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                        {!notification.isRead && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void markRead(notification);
                            }}
                            disabled={busyIds.includes(notification.id)}
                            title="Mark as read"
                            aria-label={`Mark "${notification.title}" as read`}
                            // The dot stays 8px visually, but the hit area is a
                            // full 32px — an 8px tap target is unusable on touch.
                            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-indigo-500/10 disabled:opacity-50"
                          >
                            <span className="h-2 w-2 rounded-full bg-indigo-500" />
                          </button>
                        )}
                        {/* Faintly visible by default: touch devices have no
                            hover, so a hover-only chevron never appears there. */}
                        <ChevronRight className="h-[15px] w-[15px] text-muted-foreground opacity-40 transition-opacity sm:opacity-0 sm:group-hover:opacity-60" aria-hidden="true" />
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
                onClick={() => fetchFeed(items[items.length - 1] ?? null, true)}
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
