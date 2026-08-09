/**
 * Notification Bell Component (Boundary Layer)
 *
 * Bell icon with unread count badge, placed in the sidebar.
 * Clicking opens a dropdown panel showing recent notifications.
 * Polls for unread count every 30 seconds.
 *
 * Features:
 * - Red badge with unread count
 * - Dropdown panel with notification list
 * - Click notification to mark as read + navigate
 * - "Mark all as read" button
 * - Time-ago formatting
 * - Dark mode support
 */
"use client";

import { useEffect, useState, useRef } from "react";
import { NotificationIconBadge } from "@/components/ui/notification-icon";
import { useRouter } from "next/navigation";
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

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}


export function NotificationBell({ orgId }: { orgId?: string }) {
  const { can } = usePermissions();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

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
      // Silent fail — polling is non-critical
    }
  }

  // Poll unread count every 30 seconds.
  // Notifications are org-scoped, so outside an org there is nothing to count.
  useEffect(() => {
    if (!orgId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: polls the unread count every 30 seconds
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [orgId]);

  // Close panel when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);


  async function fetchNotifications() {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/notifications?limit=10`
      );
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }

  function togglePanel() {
    if (!isOpen) {
      fetchNotifications();
    }
    setIsOpen(!isOpen);
  }

  async function handleNotificationClick(notification: Notification) {
    /*
     * Checked and rolled back, like the page already did.
     *
     * This fired the PATCH, ignored the result, and decremented the badge
     * regardless — so a 403 or a 500 still cleared the dot and the count. It
     * self-corrected within thirty seconds at the next poll, which is why it
     * survived: the symptom was a number that was briefly wrong and then
     * mysteriously right again.
     */
    if (!notification.isRead) {
      const before = notification.isRead;
      setNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        const res = await fetch(
          `/api/organizations/${orgId}/notifications/${notification.id}/read`,
          { method: "PATCH" }
        );
        if (!res.ok) throw new Error("mark-read refused");
      } catch {
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id ? { ...n, isRead: before } : n
          )
        );
        setUnreadCount((prev) => prev + 1);
      }
    }

    /*
     * The shared resolver, which the notifications page also uses.
     *
     * This switch and the page's had been written separately and disagreed:
     * the page knew what to do with an hour-limit warning and this did nothing,
     * and neither had a case for `availability`, so four leave notifications
     * were unclickable in both.
     *
     * The `entityId` requirement is gone too. It was never used to build a URL
     * — both switches read only `entityType` — so demanding it meant a
     * notification with a blank id silently refused to navigate for no reason
     * a reader could see.
     */
    if (orgId) {
      const href = notificationHref(notification.type, orgId, can);
      if (href) router.push(href);
    }

    setIsOpen(false);
  }

  async function handleMarkAllRead() {
    const previous = notifications;
    const previousCount = unreadCount;
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/notifications/mark-all-read`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("mark-all-read refused");
    } catch {
      setNotifications(previous);
      setUnreadCount(previousCount);
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={togglePanel}
        className="relative flex items-center justify-center w-9 h-9 rounded-md hover:bg-accent/50 transition-colors"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-medium px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Notification panel */}
      {isOpen && (
        <div className="fixed bottom-16 left-4 w-80 rounded-lg border bg-background shadow-lg overflow-hidden z-50">
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
            <p className="text-sm font-medium">Notifications</p>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {loading && notifications.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Loading...
              </p>
            )}

            {!loading && notifications.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No notifications yet
              </p>
            )}

            {notifications.map((notification) => (
              <button
                key={notification.id}
                onClick={() => handleNotificationClick(notification)}
                className={`w-full text-left px-4 py-3 border-b last:border-b-0 hover:bg-muted/50 transition-colors ${
                  !notification.isRead
                    ? "bg-blue-50/50 dark:bg-blue-950/30"
                    : ""
                }`}
              >
                <div className="flex gap-3">
                  <span className="text-base mt-0.5" aria-hidden="true">
                    <NotificationIconBadge type={notification.type} className="h-7 w-7" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={`text-sm truncate ${
                          !notification.isRead
                            ? "font-medium"
                            : "text-muted-foreground"
                        }`}
                      >
                        {notification.title}
                      </p>
                      {!notification.isRead && (
                        <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {notification.message}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      {timeAgo(notification.createdAt)}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
