/**
 * Notification Service (Control Layer)
 *
 * Business logic for user notifications.
 * Provides methods for creating notifications (single + bulk),
 * listing, counting unread, and marking as read.
 *
 * Notification creation is fire-and-forget — callers should
 * not await or depend on notification delivery succeeding.
 * Ownership AND organisation are verified before marking as read.
 *
 * Every notification belongs to exactly one organisation. A user who is a
 * member of two organisations gets two independent feeds: the titles and
 * messages embed that org's task names and colleague names, so merging them
 * would leak one tenant's context into the other's UI.
 */
import {
  NotificationRepository,
  type NotificationFilter,
} from "@/repositories/notification.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { startOfDayInTimeZone } from "@/lib/timezone";

/** Notification type constants */
export const NOTIFICATION_TYPES = {
  TASK_ASSIGNED: "task_assigned",
  TASK_UNASSIGNED: "task_unassigned",
  TASK_CANCELLED: "task_cancelled",
  TASK_RESCHEDULED: "task_rescheduled",
  STAFF_INELIGIBLE: "staff_ineligible",
  HOUR_LIMIT_WARNING: "hour_limit_warning",
  TASK_COMPLETED: "task_completed",
  WITHDRAWAL_REQUESTED: "withdrawal_requested",
  WITHDRAWAL_APPROVED: "withdrawal_approved",
  WITHDRAWAL_DENIED: "withdrawal_denied",
  CERT_VERIFIED: "cert_verified",
  CERT_REJECTED: "cert_rejected",
  CERT_EXPIRING: "cert_expiring",
  ORG_SUSPENDED: "org_suspended",
} as const;

/**
 * User-facing groupings for the notification feed's filter pills.
 * Presentation vocabulary lives here rather than in the page so the API and
 * the UI cannot drift apart on what "Alerts" means.
 */
export const NOTIFICATION_CATEGORIES = {
  task: [
    NOTIFICATION_TYPES.TASK_ASSIGNED,
    NOTIFICATION_TYPES.TASK_UNASSIGNED,
    NOTIFICATION_TYPES.TASK_CANCELLED,
    NOTIFICATION_TYPES.TASK_RESCHEDULED,
    NOTIFICATION_TYPES.TASK_COMPLETED,
  ],
  assignment: [
    NOTIFICATION_TYPES.WITHDRAWAL_REQUESTED,
    NOTIFICATION_TYPES.WITHDRAWAL_APPROVED,
    NOTIFICATION_TYPES.WITHDRAWAL_DENIED,
  ],
  certification: [
    NOTIFICATION_TYPES.CERT_VERIFIED,
    NOTIFICATION_TYPES.CERT_REJECTED,
    NOTIFICATION_TYPES.CERT_EXPIRING,
  ],
  alert: [
    NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
    NOTIFICATION_TYPES.STAFF_INELIGIBLE,
    NOTIFICATION_TYPES.ORG_SUSPENDED,
  ],
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;

/**
 * Types that represent something gone wrong which the recipient is expected to
 * do something about — surfaced as the "Needs action" tile.
 */
export const NEEDS_ACTION_TYPES: string[] = [
  NOTIFICATION_TYPES.CERT_EXPIRING,
  NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
  NOTIFICATION_TYPES.CERT_REJECTED,
  NOTIFICATION_TYPES.WITHDRAWAL_REQUESTED,
  NOTIFICATION_TYPES.STAFF_INELIGIBLE,
];

/**
 * Maps a notification type to the toggle in CompanySettings.notificationPreferences
 * that controls it. Types not listed here are always sent (they're not optional).
 */
const TYPE_TO_PREFERENCE: Record<string, string> = {
  [NOTIFICATION_TYPES.TASK_ASSIGNED]: "taskAssignment",
  [NOTIFICATION_TYPES.TASK_UNASSIGNED]: "taskAssignment",
  [NOTIFICATION_TYPES.TASK_CANCELLED]: "taskAssignment",
  [NOTIFICATION_TYPES.TASK_RESCHEDULED]: "taskAssignment",
  [NOTIFICATION_TYPES.STAFF_INELIGIBLE]: "taskAssignment",
  [NOTIFICATION_TYPES.HOUR_LIMIT_WARNING]: "hourLimitWarning",
  [NOTIFICATION_TYPES.CERT_EXPIRING]: "certificationExpiry",
};

export interface NotificationFeedOptions {
  category?: NotificationCategory;
  unreadOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface NotificationFeed {
  notifications: Awaited<
    ReturnType<NotificationRepository["findByUserId"]>
  >;
  /** Total matching the CURRENT filter — drives "load more". */
  total: number;
  hasMore: boolean;
  /** Counts below are unfiltered, so the pills and tiles never move as you filter. */
  unreadCount: number;
  todayCount: number;
  needsActionCount: number;
  counts: {
    all: number;
    unread: number;
    task: number;
    assignment: number;
    certification: number;
    alert: number;
  };
}

export class NotificationService {
  private notificationRepo = new NotificationRepository();
  private settingsRepo = new SettingsRepository();

  /**
   * Whether an org has this notification type enabled.
   * Defaults to true — a missing/unparseable preference never silences alerts.
   */
  async isTypeEnabled(organizationId: string, type: string): Promise<boolean> {
    const prefKey = TYPE_TO_PREFERENCE[type];
    if (!prefKey) return true; // not a gated type

    try {
      const settings = await this.settingsRepo.getOrCreate(organizationId);
      if (!settings.notificationPreferences) return true;
      const prefs = JSON.parse(settings.notificationPreferences) as Record<
        string,
        boolean
      >;
      return prefs[prefKey] !== false;
    } catch {
      return true;
    }
  }

  /**
   * Sends a notification only if the org has the type enabled.
   * Fire-and-forget — errors are logged, never thrown.
   */
  async notifyIfEnabled(
    organizationId: string,
    userId: string,
    type: string,
    title: string,
    message: string,
    entityType?: string,
    entityId?: string
  ) {
    if (!(await this.isTypeEnabled(organizationId, type))) return;
    return this.notify(
      organizationId,
      userId,
      type,
      title,
      message,
      entityType,
      entityId
    );
  }

  /** Sends to many users, respecting the org's notification preferences. */
  async notifyManyIfEnabled(
    organizationId: string,
    userIds: string[],
    type: string,
    title: string,
    message: string,
    entityType?: string,
    entityId?: string
  ) {
    if (userIds.length === 0) return;
    if (!(await this.isTypeEnabled(organizationId, type))) return;
    return this.notifyMany(
      organizationId,
      userIds,
      type,
      title,
      message,
      entityType,
      entityId
    );
  }

  /**
   * True if this user already got this alert type (about this entity)
   * in this org since `since`. Used to avoid repeat alerts.
   */
  async wasNotifiedSince(
    userId: string,
    organizationId: string,
    type: string,
    since: Date,
    entityId?: string
  ): Promise<boolean> {
    return this.notificationRepo.existsSince(
      userId,
      organizationId,
      type,
      since,
      entityId
    );
  }

  /**
   * Creates a notification for a single user.
   * Fire-and-forget — errors are logged, never thrown.
   */
  async notify(
    organizationId: string,
    userId: string,
    type: string,
    title: string,
    message: string,
    entityType?: string,
    entityId?: string
  ) {
    try {
      await this.notificationRepo.create({
        userId,
        organizationId,
        type,
        title,
        message,
        entityType,
        entityId,
      });
    } catch (error) {
      console.error("[Notification Error]", error);
    }
  }

  /**
   * Creates notifications for multiple users at once.
   * Fire-and-forget — errors are logged, never thrown.
   */
  async notifyMany(
    organizationId: string,
    userIds: string[],
    type: string,
    title: string,
    message: string,
    entityType?: string,
    entityId?: string
  ) {
    try {
      const notifications = userIds.map((userId) => ({
        userId,
        organizationId,
        type,
        title,
        message,
        entityType,
        entityId,
      }));
      await this.notificationRepo.createMany(notifications);
    } catch (error) {
      console.error("[Notification Error]", error);
    }
  }

  /**
   * Returns one page of the feed plus every count the page renders.
   *
   * The counts are deliberately computed unfiltered: a filter pill that
   * changed its own count when selected would be unreadable, and a "Today"
   * tile that shrank when you searched would look broken.
   */
  async getFeed(
    userId: string,
    organizationId: string,
    options: NotificationFeedOptions = {}
  ): Promise<NotificationFeed> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const offset = Math.max(options.offset ?? 0, 0);

    const filter: NotificationFilter = {
      types: options.category
        ? [...NOTIFICATION_CATEGORIES[options.category]]
        : undefined,
      unreadOnly: options.unreadOnly,
      search: options.search,
    };

    // "Today" means today in the organisation's timezone, not the server's.
    // On Vercel the server clock is UTC, so a bare start-of-day would roll
    // over at 08:00 Singapore time and under-report all morning.
    const since = startOfDayInTimeZone();

    const [notifications, total, unreadCount, byType, todayCount] =
      await Promise.all([
        this.notificationRepo.findByUserId(
          userId,
          organizationId,
          limit,
          offset,
          filter
        ),
        this.notificationRepo.countMatching(userId, organizationId, filter),
        this.notificationRepo.countUnread(userId, organizationId),
        this.notificationRepo.countByType(userId, organizationId),
        this.notificationRepo.countSince(userId, organizationId, since),
      ]);

    const sumTypes = (types: readonly string[]) =>
      types.reduce((total, type) => total + (byType[type] ?? 0), 0);

    const all = Object.values(byType).reduce((sum, count) => sum + count, 0);

    return {
      notifications,
      total,
      hasMore: offset + notifications.length < total,
      unreadCount,
      todayCount,
      needsActionCount: sumTypes(NEEDS_ACTION_TYPES),
      counts: {
        all,
        unread: unreadCount,
        task: sumTypes(NOTIFICATION_CATEGORIES.task),
        assignment: sumTypes(NOTIFICATION_CATEGORIES.assignment),
        certification: sumTypes(NOTIFICATION_CATEGORIES.certification),
        alert: sumTypes(NOTIFICATION_CATEGORIES.alert),
      },
    };
  }

  /** Returns paginated notifications for a user within an org */
  async getNotifications(
    userId: string,
    organizationId: string,
    limit = 20,
    offset = 0
  ) {
    return this.notificationRepo.findByUserId(
      userId,
      organizationId,
      limit,
      offset
    );
  }

  /** Returns the unread notification count for a user within an org */
  async getUnreadCount(
    userId: string,
    organizationId: string
  ): Promise<number> {
    return this.notificationRepo.countUnread(userId, organizationId);
  }

  /**
   * Marks a single notification as read.
   * Verifies ownership AND organisation — a user may only mark their own
   * notifications, and only from inside the org the notification belongs to.
   */
  async markAsRead(
    notificationId: string,
    userId: string,
    organizationId: string
  ) {
    const notification = await this.notificationRepo.findById(notificationId);
    if (!notification) {
      throw new Error("Notification not found");
    }
    if (notification.userId !== userId) {
      throw new Error("Not authorized");
    }
    if (notification.organizationId !== organizationId) {
      // Same message as a missing record: never confirm to a caller that a
      // notification exists in an org they are not looking at.
      throw new Error("Notification not found");
    }
    return this.notificationRepo.markAsRead(notificationId);
  }

  /** Marks all of a user's notifications as read within one org */
  async markAllAsRead(userId: string, organizationId: string) {
    return this.notificationRepo.markAllAsRead(userId, organizationId);
  }
}
