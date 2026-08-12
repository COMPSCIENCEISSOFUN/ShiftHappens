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
/*
 * The vocabulary lives in `lib/notification-types` and is re-exported here.
 *
 * Every one of these was declared in this file, which imports the repository
 * and therefore Prisma — so the notifications page and the bell could not read
 * them and kept their own copies. Four hand-written lists of the same thing,
 * already drifted. Re-exported rather than moved outright so the ~30 services
 * that write notifications keep importing the name they always have.
 *
 * Same arrangement as `audit-log.service`, for the same reason.
 */
export {
  NOTIFICATION_TYPES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_LABELS,
  NOTIFICATION_TYPE_LIST,
  NEEDS_ACTION_TYPES,
  type NotificationType,
  type NotificationCategory,
} from "@/lib/notification-types";

import {
  NOTIFICATION_TYPES,
  NOTIFICATION_CATEGORIES,
  NEEDS_ACTION_TYPES,
  type NotificationCategory,
} from "@/lib/notification-types";

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
  [NOTIFICATION_TYPES.ASSIGNMENT_REJECTED]: "taskRejection",
  [NOTIFICATION_TYPES.HOUR_LIMIT_WARNING]: "hourLimitWarning",
  [NOTIFICATION_TYPES.CERT_EXPIRING]: "certificationExpiry",
  /*
   * Staffing shortfalls get their own switch rather than joining
   * `taskAssignment`.
   *
   * That one is about a member's OWN shifts changing and is read by staff; these
   * two are addressed to whoever finds people, and an organisation that wants
   * one does not necessarily want the other. Sharing a key would mean silencing
   * "you have been assigned" also silenced "this shift has nobody on it".
   */
  [NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED]: "taskStaffing",
  [NOTIFICATION_TYPES.TASK_UNFILLED]: "taskStaffing",
  /*
   * The OUTCOME of a withdrawal, and only the outcome.
   *
   * `WITHDRAWAL_REQUESTED` is deliberately absent and must stay absent. It is
   * in `NEEDS_ACTION_TYPES` because a manager has to answer it, and a switch
   * that hides it would let an organisation silence a decision that is waiting
   * on them — the request would sit unanswered with nothing anywhere saying so.
   * Same reasoning `LEAVE_REMINDER` is given in `notification-types`: a setting
   * whose only effect is to make the first warning somebody gets be the angry
   * one.
   */
  [NOTIFICATION_TYPES.WITHDRAWAL_APPROVED]: "taskWithdrawal",
  [NOTIFICATION_TYPES.WITHDRAWAL_DENIED]: "taskWithdrawal",
};

export interface NotificationFeedOptions {
  category?: NotificationCategory;
  unreadOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * The last row the client already holds, for "load older".
   *
   * Both are needed together — see `getFeed`. Supplied as strings because they
   * arrive from a query string.
   */
  beforeCreatedAt?: string;
  beforeId?: string;
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
  /** ISO instant the organisation's day began. See `getFeed`. */
  todayStart: string;
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

    /*
     * The cursor for "load older": the last row the client already has.
     *
     * Both halves are required. A cursor carrying only the timestamp would skip
     * the rest of a tied group — `createdAt` is `timestamp(3)` and one action
     * notifying several people writes them in the same millisecond routinely —
     * so a half-supplied cursor is ignored rather than half-applied.
     */
    const before =
      options.beforeCreatedAt && options.beforeId
        ? {
            createdAt: new Date(options.beforeCreatedAt),
            id: options.beforeId,
          }
        : undefined;

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
          filter,
          before
        ),
        this.notificationRepo.countMatching(userId, organizationId, filter),
        this.notificationRepo.countUnread(userId, organizationId),
        this.notificationRepo.countByType(userId, organizationId),
        this.notificationRepo.countSince(userId, organizationId, since),
      ]);

    const sumTypes = (types: readonly string[]) =>
      types.reduce((total, type) => total + (byType.all[type] ?? 0), 0);

    const all = Object.values(byType.all).reduce((sum, count) => sum + count, 0);

    /*
     * "Needs action" counts only what is still UNREAD.
     *
     * It was summed from the all-time counts, so a rejection read months ago
     * kept contributing to a tile that says something is waiting for you — the
     * number never went down as you dealt with things, which is the only
     * behaviour it needed to have.
     */
    const needsActionCount = NEEDS_ACTION_TYPES.reduce(
      (total, type) => total + (byType.unread[type] ?? 0),
      0
    );

    return {
      notifications,
      total,
      /*
       * With a cursor there is no offset to add, so a full page is the signal
       * that more may exist. It can be one request optimistic — a page that
       * happens to end exactly on the boundary shows the button once more and
       * then reports nothing further — which is the harmless direction. The
       * alternative, counting rows older than the cursor, is a second query on
       * every scroll to avoid one wasted click.
       */
      hasMore: before
        ? notifications.length === limit
        : offset + notifications.length < total,
      unreadCount,
      todayCount,
      needsActionCount,
      /*
       * The instant "today" started, so the page can group its date headings by
       * the same boundary the tile counted against.
       *
       * The tile used the organisation's timezone and the headings used the
       * browser's local midnight, so for any reader outside Singapore the two
       * described different sets — a notification could sit under "Yesterday"
       * while being counted in "Today".
       */
      todayStart: since.toISOString(),
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
   *
   * Verifies ownership AND organisation — a user may only mark their own
   * notifications, and only from inside the org the notification belongs to.
   *
   * Both refusals answer "not found", and the ORDER used to matter: ownership
   * was checked first and threw "Not authorized", so a caller holding an id
   * belonging to somebody else learned it was real before the organisation
   * check could decline to say so. The comment on that check already claimed
   * the endpoint never confirms a notification exists in an org the caller is
   * not looking at — the 403 above it had already done exactly that. One
   * answer for both is the convention everywhere else in this codebase.
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
    if (
      notification.userId !== userId ||
      notification.organizationId !== organizationId
    ) {
      throw new Error("Notification not found");
    }
    return this.notificationRepo.markAsRead(notificationId);
  }

  /** Marks all of a user's notifications as read within one org */
  async markAllAsRead(userId: string, organizationId: string) {
    return this.notificationRepo.markAllAsRead(userId, organizationId);
  }
}
