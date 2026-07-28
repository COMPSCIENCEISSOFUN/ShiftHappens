/**
 * Tests for Notification Service (Control Layer)
 *
 * Covers notification creation (single + bulk), fire-and-forget behaviour,
 * pagination, unread counting, mark-as-read with ownership AND organisation
 * verification, mark-all-as-read, preference gating, and the aggregated feed
 * that drives the notifications page.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  NotificationService,
  NOTIFICATION_TYPES,
  NOTIFICATION_CATEGORIES,
  NEEDS_ACTION_TYPES,
} from "@/services/notification.service";
import { UserRepository } from "@/repositories/user.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const notificationService = new NotificationService();
const userRepo = new UserRepository();
const orgRepo = new OrganizationRepository();

let userId: string;
let otherUserId: string;
let orgId: string;
let otherOrgId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Test User",
    email: "user@test.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const other = await userRepo.create({
    name: "Other User",
    email: "other@test.com",
    hashedPassword: "hash",
  });
  otherUserId = other.id;

  const org = await orgRepo.create(
    { name: "Ocean Grill", slug: "ocean-grill" },
    userId
  );
  orgId = org.id;

  // Same user, second org — the dual-org case the org column exists for.
  const otherOrg = await orgRepo.create(
    { name: "Harbour Cafe", slug: "harbour-cafe" },
    userId
  );
  otherOrgId = otherOrg.id;
});

describe("NotificationService", () => {
  describe("notify", () => {
    it("creates a notification for a user in an org", async () => {
      await notificationService.notify(
        orgId,
        userId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "New assignment",
        "You've been assigned to Kitchen prep",
        "assignment",
        "task-123"
      );

      const notifications = await notificationService.getNotifications(userId, orgId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("task_assigned");
      expect(notifications[0].organizationId).toBe(orgId);
      expect(notifications[0].isRead).toBe(false);
    });

    it("does not throw on invalid userId (fire-and-forget)", async () => {
      await expect(
        notificationService.notify(
          orgId,
          "nonexistent-user-id",
          NOTIFICATION_TYPES.TASK_ASSIGNED,
          "Test",
          "Message"
        )
      ).resolves.not.toThrow();
    });

    it("does not throw on invalid organizationId (fire-and-forget)", async () => {
      await expect(
        notificationService.notify(
          "nonexistent-org-id",
          userId,
          NOTIFICATION_TYPES.TASK_ASSIGNED,
          "Test",
          "Message"
        )
      ).resolves.not.toThrow();
    });
  });

  describe("notifyMany", () => {
    it("creates notifications for multiple users", async () => {
      await notificationService.notifyMany(
        orgId,
        [userId, otherUserId],
        NOTIFICATION_TYPES.ORG_SUSPENDED,
        "Organization suspended",
        "Your organization has been suspended"
      );

      expect(await notificationService.getNotifications(userId, orgId)).toHaveLength(1);
      expect(
        await notificationService.getNotifications(otherUserId, orgId)
      ).toHaveLength(1);
    });

    it("handles empty user list without error", async () => {
      await expect(
        notificationService.notifyMany(orgId, [], "test", "Test", "Message")
      ).resolves.not.toThrow();
    });
  });

  describe("getNotifications", () => {
    it("returns notifications with pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await notificationService.notify(
          orgId,
          userId,
          NOTIFICATION_TYPES.TASK_ASSIGNED,
          `Notification ${i}`,
          `Message ${i}`
        );
      }

      const page1 = await notificationService.getNotifications(userId, orgId, 2, 0);
      const page2 = await notificationService.getNotifications(userId, orgId, 2, 2);

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
    });

    it("returns empty array for user with no notifications", async () => {
      expect(await notificationService.getNotifications(userId, orgId)).toEqual([]);
    });

    it("does not leak the user's other org into this feed", async () => {
      await notificationService.notify(otherOrgId, userId, "test", "Elsewhere", "Msg");

      expect(await notificationService.getNotifications(userId, orgId)).toEqual([]);
      expect(
        await notificationService.getNotifications(userId, otherOrgId)
      ).toHaveLength(1);
    });
  });

  describe("getUnreadCount", () => {
    it("returns correct unread count", async () => {
      await notificationService.notify(orgId, userId, "test", "N1", "Msg");
      await notificationService.notify(orgId, userId, "test", "N2", "Msg");

      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(2);
    });

    it("returns 0 when no notifications exist", async () => {
      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(0);
    });

    it("counts each org separately", async () => {
      await notificationService.notify(orgId, userId, "test", "N1", "Msg");
      await notificationService.notify(otherOrgId, userId, "test", "N2", "Msg");

      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(1);
      expect(await notificationService.getUnreadCount(userId, otherOrgId)).toBe(1);
    });

    it("decreases after marking as read", async () => {
      await notificationService.notify(orgId, userId, "test", "N1", "Msg");
      await notificationService.notify(orgId, userId, "test", "N2", "Msg");

      const notifications = await notificationService.getNotifications(userId, orgId);
      await notificationService.markAsRead(notifications[0].id, userId, orgId);

      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(1);
    });
  });

  describe("markAsRead", () => {
    it("marks a notification as read", async () => {
      await notificationService.notify(orgId, userId, "test", "Test", "Msg");

      const notifications = await notificationService.getNotifications(userId, orgId);
      const result = await notificationService.markAsRead(
        notifications[0].id,
        userId,
        orgId
      );

      expect(result.isRead).toBe(true);
    });

    it("throws for non-existent notification", async () => {
      await expect(
        notificationService.markAsRead("nonexistent", userId, orgId)
      ).rejects.toThrow("Notification not found");
    });

    it("throws when user tries to mark another user's notification", async () => {
      await notificationService.notify(orgId, otherUserId, "test", "Not mine", "Msg");

      const notifications = await notificationService.getNotifications(
        otherUserId,
        orgId
      );

      await expect(
        notificationService.markAsRead(notifications[0].id, userId, orgId)
      ).rejects.toThrow("Not authorized");
    });

    it("throws when marking one's own notification from the wrong org", async () => {
      await notificationService.notify(otherOrgId, userId, "test", "Elsewhere", "Msg");

      const notifications = await notificationService.getNotifications(
        userId,
        otherOrgId
      );

      // Reported as "not found" rather than "forbidden" — the caller must not
      // learn that a notification exists in an org they are not looking at.
      await expect(
        notificationService.markAsRead(notifications[0].id, userId, orgId)
      ).rejects.toThrow("Notification not found");
    });
  });

  describe("markAllAsRead", () => {
    it("marks all notifications as read for a user in this org", async () => {
      await notificationService.notify(orgId, userId, "test", "N1", "Msg");
      await notificationService.notify(orgId, userId, "test", "N2", "Msg");
      await notificationService.notify(orgId, userId, "test", "N3", "Msg");

      await notificationService.markAllAsRead(userId, orgId);

      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(0);
    });

    it("does not affect the user's other org", async () => {
      await notificationService.notify(orgId, userId, "test", "Here", "Msg");
      await notificationService.notify(otherOrgId, userId, "test", "Elsewhere", "Msg");

      await notificationService.markAllAsRead(userId, orgId);

      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(0);
      expect(await notificationService.getUnreadCount(userId, otherOrgId)).toBe(1);
    });

    it("does not affect other users' notifications", async () => {
      await notificationService.notify(orgId, userId, "test", "Mine", "Msg");
      await notificationService.notify(orgId, otherUserId, "test", "Theirs", "Msg");

      await notificationService.markAllAsRead(userId, orgId);

      expect(await notificationService.getUnreadCount(userId, orgId)).toBe(0);
      expect(await notificationService.getUnreadCount(otherUserId, orgId)).toBe(1);
    });
  });

  describe("getFeed", () => {
    beforeEach(async () => {
      await notificationService.notify(
        orgId,
        userId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "Kitchen prep",
        "You've been assigned"
      );
      await notificationService.notify(
        orgId,
        userId,
        NOTIFICATION_TYPES.ASSIGNMENT_REJECTED,
        "Mike declined",
        "Schedule conflict"
      );
      await notificationService.notify(
        orgId,
        userId,
        NOTIFICATION_TYPES.CERT_VERIFIED,
        "Food Safety verified",
        "You are now eligible"
      );
      await notificationService.notify(
        orgId,
        userId,
        NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
        "Approaching limit",
        "44 of 48 hours"
      );
    });

    it("returns the page plus every count the header renders", async () => {
      const feed = await notificationService.getFeed(userId, orgId);

      expect(feed.notifications).toHaveLength(4);
      expect(feed.total).toBe(4);
      expect(feed.hasMore).toBe(false);
      expect(feed.unreadCount).toBe(4);
      expect(feed.counts.all).toBe(4);
      expect(feed.counts.task).toBe(1);
      expect(feed.counts.assignment).toBe(1);
      expect(feed.counts.certification).toBe(1);
      expect(feed.counts.alert).toBe(1);
    });

    it("counts today's notifications", async () => {
      const feed = await notificationService.getFeed(userId, orgId);
      expect(feed.todayCount).toBe(4);
    });

    it("counts the ones that need action", async () => {
      const feed = await notificationService.getFeed(userId, orgId);
      // assignment_rejected + hour_limit_warning
      expect(feed.needsActionCount).toBe(2);
    });

    it("filters by category without changing the pill counts", async () => {
      const feed = await notificationService.getFeed(userId, orgId, {
        category: "certification",
      });

      expect(feed.notifications).toHaveLength(1);
      expect(feed.total).toBe(1);
      // Counts stay unfiltered so the pills do not move when one is selected.
      expect(feed.counts.all).toBe(4);
      expect(feed.counts.task).toBe(1);
    });

    it("filters to unread only", async () => {
      const all = await notificationService.getNotifications(userId, orgId);
      await notificationService.markAsRead(all[0].id, userId, orgId);

      const feed = await notificationService.getFeed(userId, orgId, {
        unreadOnly: true,
      });

      expect(feed.notifications).toHaveLength(3);
      expect(feed.unreadCount).toBe(3);
    });

    it("searches title and message", async () => {
      const feed = await notificationService.getFeed(userId, orgId, {
        search: "kitchen",
      });

      expect(feed.notifications).toHaveLength(1);
      expect(feed.total).toBe(1);
    });

    it("reports hasMore correctly while paginating", async () => {
      const page1 = await notificationService.getFeed(userId, orgId, { limit: 2 });
      expect(page1.notifications).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await notificationService.getFeed(userId, orgId, {
        limit: 2,
        offset: 2,
      });
      expect(page2.notifications).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });

    it("clamps an oversized limit rather than failing", async () => {
      const feed = await notificationService.getFeed(userId, orgId, { limit: 5000 });
      expect(feed.notifications.length).toBeLessThanOrEqual(50);
    });

    it("returns empty structure for an org with no notifications", async () => {
      const feed = await notificationService.getFeed(userId, otherOrgId);

      expect(feed.notifications).toEqual([]);
      expect(feed.total).toBe(0);
      expect(feed.hasMore).toBe(false);
      expect(feed.unreadCount).toBe(0);
      expect(feed.counts.all).toBe(0);
    });

    it("never includes the user's other org", async () => {
      await notificationService.notify(
        otherOrgId,
        userId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "Harbour Cafe shift",
        "Different tenant"
      );

      const feed = await notificationService.getFeed(userId, orgId);

      expect(feed.counts.all).toBe(4);
      expect(
        feed.notifications.some((n) => n.title === "Harbour Cafe shift")
      ).toBe(false);
    });
  });

  describe("category constants", () => {
    it("assigns every notification type to exactly one category", () => {
      const categorised = Object.values(NOTIFICATION_CATEGORIES).flat();
      const allTypes = Object.values(NOTIFICATION_TYPES);

      for (const type of allTypes) {
        expect(categorised.filter((t) => t === type)).toHaveLength(1);
      }
      expect(categorised).toHaveLength(allTypes.length);
    });

    it("only lists real notification types as needing action", () => {
      const allTypes = Object.values(NOTIFICATION_TYPES) as string[];
      for (const type of NEEDS_ACTION_TYPES) {
        expect(allTypes).toContain(type);
      }
    });
  });

  describe("NOTIFICATION_TYPES", () => {
    it("exports all expected type constants", () => {
      expect(NOTIFICATION_TYPES.TASK_ASSIGNED).toBe("task_assigned");
      expect(NOTIFICATION_TYPES.ASSIGNMENT_ACCEPTED).toBe("assignment_accepted");
      expect(NOTIFICATION_TYPES.ASSIGNMENT_REJECTED).toBe("assignment_rejected");
      expect(NOTIFICATION_TYPES.CERT_VERIFIED).toBe("cert_verified");
      expect(NOTIFICATION_TYPES.CERT_REJECTED).toBe("cert_rejected");
      expect(NOTIFICATION_TYPES.ORG_SUSPENDED).toBe("org_suspended");
    });
  });
});

// ─── Preference-gated delivery (Feature: Notifications & Hour Alerts) ───────
describe("NotificationService — preference gating", () => {
  let prefUserId: string;
  let prefOrgId: string;

  /** Set the org's notificationPreferences JSON. */
  async function setPreferences(prefs: Record<string, boolean>) {
    await prisma.companySettings.update({
      where: { organizationId: prefOrgId },
      data: { notificationPreferences: JSON.stringify(prefs) },
    });
  }

  beforeEach(async () => {
    await cleanDatabase();

    const user = await userRepo.create({
      name: "Admin",
      email: "admin@pref.com",
      hashedPassword: "hash",
    });
    prefUserId = user.id;

    const org = await orgRepo.create(
      { name: "Pref Org", slug: "pref-org" },
      user.id
    );
    prefOrgId = org.id;
    // Ensure a CompanySettings row exists to update.
    await prisma.companySettings.upsert({
      where: { organizationId: prefOrgId },
      create: { organizationId: prefOrgId },
      update: {},
    });
  });

  describe("isTypeEnabled", () => {
    it("defaults to true when no preferences are set", async () => {
      expect(
        await notificationService.isTypeEnabled(
          prefOrgId,
          NOTIFICATION_TYPES.TASK_ASSIGNED
        )
      ).toBe(true);
    });

    it("returns true for a non-gated type regardless of preferences", async () => {
      await setPreferences({ taskAssignment: false });
      expect(
        await notificationService.isTypeEnabled(
          prefOrgId,
          NOTIFICATION_TYPES.ASSIGNMENT_ACCEPTED
        )
      ).toBe(true);
    });

    it("returns false when the mapped preference is disabled", async () => {
      await setPreferences({ taskAssignment: false });
      expect(
        await notificationService.isTypeEnabled(
          prefOrgId,
          NOTIFICATION_TYPES.TASK_ASSIGNED
        )
      ).toBe(false);
    });

    it("gates HOUR_LIMIT_WARNING on the hourLimitWarning preference", async () => {
      await setPreferences({ hourLimitWarning: false });
      expect(
        await notificationService.isTypeEnabled(
          prefOrgId,
          NOTIFICATION_TYPES.HOUR_LIMIT_WARNING
        )
      ).toBe(false);
    });
  });

  describe("notifyIfEnabled", () => {
    it("delivers when the type is enabled", async () => {
      await notificationService.notifyIfEnabled(
        prefOrgId,
        prefUserId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "Assigned",
        "You have a new task"
      );
      expect(
        await notificationService.getNotifications(prefUserId, prefOrgId)
      ).toHaveLength(1);
    });

    it("suppresses delivery when the type is disabled", async () => {
      await setPreferences({ taskAssignment: false });
      await notificationService.notifyIfEnabled(
        prefOrgId,
        prefUserId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "Assigned",
        "You have a new task"
      );
      expect(
        await notificationService.getNotifications(prefUserId, prefOrgId)
      ).toHaveLength(0);
    });
  });

  describe("notifyManyIfEnabled", () => {
    it("does nothing for an empty recipient list", async () => {
      await expect(
        notificationService.notifyManyIfEnabled(
          prefOrgId,
          [],
          NOTIFICATION_TYPES.TASK_RESCHEDULED,
          "Rescheduled",
          "Time changed"
        )
      ).resolves.not.toThrow();
    });

    it("suppresses delivery to all when the type is disabled", async () => {
      await setPreferences({ taskAssignment: false });
      await notificationService.notifyManyIfEnabled(
        prefOrgId,
        [prefUserId],
        NOTIFICATION_TYPES.TASK_RESCHEDULED,
        "Rescheduled",
        "Time changed"
      );
      expect(
        await notificationService.getNotifications(prefUserId, prefOrgId)
      ).toHaveLength(0);
    });
  });

  describe("wasNotifiedSince", () => {
    it("is true after a matching notification and false otherwise", async () => {
      const since = new Date(Date.now() - 60_000);
      expect(
        await notificationService.wasNotifiedSince(
          prefUserId,
          prefOrgId,
          NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
          since,
          "task-1"
        )
      ).toBe(false);

      await notificationService.notify(
        prefOrgId,
        prefUserId,
        NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
        "Hours",
        "Approaching limit",
        "task",
        "task-1"
      );

      expect(
        await notificationService.wasNotifiedSince(
          prefUserId,
          prefOrgId,
          NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
          since,
          "task-1"
        )
      ).toBe(true);
    });
  });
});
