/**
 * Tests for Notification Repository (Entity Layer)
 *
 * Covers CRUD operations, pagination, filtering (category / unread / search),
 * counting (unread, per-type, since), mark-as-read (single + bulk), bulk
 * create, user isolation, and — critically — organisation isolation: a user
 * who belongs to two orgs must get two entirely separate feeds.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { NotificationRepository } from "@/repositories/notification.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { cleanDatabase } from "../helpers/cleanup";

const notificationRepo = new NotificationRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

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

  // The same user also belongs to a second org — the dual-org case.
  const otherOrg = await orgRepo.create(
    { name: "Harbour Cafe", slug: "harbour-cafe" },
    userId
  );
  otherOrgId = otherOrg.id;
});

/** Convenience factory so each test states only what it cares about. */
async function seed(overrides: Partial<Parameters<NotificationRepository["create"]>[0]> = {}) {
  return notificationRepo.create({
    userId,
    organizationId: orgId,
    type: "task_assigned",
    title: "New task",
    message: "You've been assigned to Kitchen prep",
    ...overrides,
  });
}

describe("NotificationRepository", () => {
  describe("create", () => {
    it("creates a notification with all fields", async () => {
      const notification = await notificationRepo.create({
        userId,
        organizationId: orgId,
        type: "task_assigned",
        title: "New task",
        message: "You've been assigned to Kitchen prep",
        entityType: "assignment",
        entityId: "task-123",
      });

      expect(notification.id).toBeDefined();
      expect(notification.userId).toBe(userId);
      expect(notification.organizationId).toBe(orgId);
      expect(notification.type).toBe("task_assigned");
      expect(notification.entityType).toBe("assignment");
      expect(notification.entityId).toBe("task-123");
      expect(notification.isRead).toBe(false);
      expect(notification.createdAt).toBeDefined();
    });

    it("creates a notification without optional fields", async () => {
      const notification = await seed();

      expect(notification.entityType).toBeNull();
      expect(notification.entityId).toBeNull();
      expect(notification.isRead).toBe(false);
    });
  });

  describe("createMany", () => {
    it("creates notifications for several users at once", async () => {
      await notificationRepo.createMany([
        {
          userId,
          organizationId: orgId,
          type: "org_suspended",
          title: "Suspended",
          message: "Org suspended",
        },
        {
          userId: otherUserId,
          organizationId: orgId,
          type: "org_suspended",
          title: "Suspended",
          message: "Org suspended",
        },
      ]);

      expect(await notificationRepo.countMatching(userId, orgId)).toBe(1);
      expect(await notificationRepo.countMatching(otherUserId, orgId)).toBe(1);
    });
  });

  describe("findByUserId", () => {
    it("returns notifications newest first", async () => {
      await seed({ title: "First" });
      await seed({ title: "Second" });
      await seed({ title: "Third" });

      const results = await notificationRepo.findByUserId(userId, orgId);

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe("Third");
      expect(results[2].title).toBe("First");
    });

    it("paginates with limit and offset", async () => {
      for (const title of ["A", "B", "C", "D", "E"]) await seed({ title });

      const page1 = await notificationRepo.findByUserId(userId, orgId, 2, 0);
      const page2 = await notificationRepo.findByUserId(userId, orgId, 2, 2);

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it("returns an empty array when there are none", async () => {
      expect(await notificationRepo.findByUserId(userId, orgId)).toEqual([]);
    });

    it("never returns another user's notifications", async () => {
      await notificationRepo.create({
        userId: otherUserId,
        organizationId: orgId,
        type: "task_assigned",
        title: "Not yours",
        message: "Private",
      });

      expect(await notificationRepo.findByUserId(userId, orgId)).toEqual([]);
    });

    it("never returns the same user's notifications from another org", async () => {
      await seed({ title: "Ocean Grill task" });
      await seed({ organizationId: otherOrgId, title: "Harbour Cafe task" });

      const oceanFeed = await notificationRepo.findByUserId(userId, orgId);
      const harbourFeed = await notificationRepo.findByUserId(userId, otherOrgId);

      expect(oceanFeed).toHaveLength(1);
      expect(oceanFeed[0].title).toBe("Ocean Grill task");
      expect(harbourFeed).toHaveLength(1);
      expect(harbourFeed[0].title).toBe("Harbour Cafe task");
    });
  });

  describe("filtering", () => {
    beforeEach(async () => {
      // Distinct messages: with the factory's shared default message, a search
      // for a word in one title would match every row via its message instead.
      await seed({
        type: "task_assigned",
        title: "Kitchen prep",
        message: "You've been assigned to the morning shift",
      });
      await seed({
        type: "cert_verified",
        title: "Food Safety verified",
        message: "Your certificate was approved",
      });
      await seed({
        type: "hour_limit_warning",
        title: "Approaching limit",
        message: "You have worked 44 of 48 hours",
      });
    });

    it("filters by type", async () => {
      const results = await notificationRepo.findByUserId(userId, orgId, 20, 0, {
        types: ["cert_verified", "cert_rejected"],
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Food Safety verified");
    });

    it("filters unread only", async () => {
      const all = await notificationRepo.findByUserId(userId, orgId);
      await notificationRepo.markAsRead(all[0].id);

      const unread = await notificationRepo.findByUserId(userId, orgId, 20, 0, {
        unreadOnly: true,
      });

      expect(unread).toHaveLength(2);
      expect(unread.every((n) => !n.isRead)).toBe(true);
    });

    it("searches title and message case-insensitively", async () => {
      const byTitle = await notificationRepo.findByUserId(userId, orgId, 20, 0, {
        search: "KITCHEN",
      });
      expect(byTitle).toHaveLength(1);
      expect(byTitle[0].title).toBe("Kitchen prep");

      // Matches on the message only — proves the OR covers both columns.
      const byMessage = await notificationRepo.findByUserId(userId, orgId, 20, 0, {
        search: "MORNING SHIFT",
      });
      expect(byMessage).toHaveLength(1);
      expect(byMessage[0].title).toBe("Kitchen prep");
    });

    it("treats a blank search as no search", async () => {
      const results = await notificationRepo.findByUserId(userId, orgId, 20, 0, {
        search: "   ",
      });
      expect(results).toHaveLength(3);
    });

    it("returns nothing when the search matches nothing", async () => {
      const results = await notificationRepo.findByUserId(userId, orgId, 20, 0, {
        search: "nonexistent-string",
      });
      expect(results).toEqual([]);
    });

    it("countMatching applies the same filter as findByUserId", async () => {
      const filter = { types: ["task_assigned"] };
      const rows = await notificationRepo.findByUserId(userId, orgId, 20, 0, filter);
      const count = await notificationRepo.countMatching(userId, orgId, filter);

      expect(count).toBe(rows.length);
      expect(count).toBe(1);
    });
  });

  describe("countUnread", () => {
    it("counts only unread notifications in this org", async () => {
      await seed();
      await seed();
      await seed({ organizationId: otherOrgId });

      expect(await notificationRepo.countUnread(userId, orgId)).toBe(2);
      expect(await notificationRepo.countUnread(userId, otherOrgId)).toBe(1);
    });

    it("returns zero when everything is read", async () => {
      const notification = await seed();
      await notificationRepo.markAsRead(notification.id);

      expect(await notificationRepo.countUnread(userId, orgId)).toBe(0);
    });
  });

  describe("countByType", () => {
    it("returns a count per type, scoped to the org", async () => {
      await seed({ type: "task_assigned" });
      await seed({ type: "task_assigned" });
      await seed({ type: "cert_verified" });
      await seed({ organizationId: otherOrgId, type: "cert_verified" });

      const counts = await notificationRepo.countByType(userId, orgId);

      expect(counts["task_assigned"]).toBe(2);
      expect(counts["cert_verified"]).toBe(1);
    });

    it("returns an empty object when there are none", async () => {
      expect(await notificationRepo.countByType(userId, orgId)).toEqual({});
    });
  });

  describe("countSince", () => {
    it("counts notifications at or after the given instant", async () => {
      await seed({ title: "older" });
      // Guarantee the two rows land in different milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await seed({ title: "newer" });

      // Take the cutoff from the stored value rather than `new Date()`.
      // createdAt is written by Postgres and rounded to millisecond precision,
      // so a JS timestamp captured between the two inserts can sit just below
      // the rounded value of the earlier row and pull it into the count.
      const [newest] = await notificationRepo.findByUserId(userId, orgId);
      expect(newest.title).toBe("newer");

      expect(
        await notificationRepo.countSince(userId, orgId, newest.createdAt)
      ).toBe(1);
    });

    it("counts nothing for a future cutoff", async () => {
      await seed();
      const future = new Date(Date.now() + 60_000);

      expect(await notificationRepo.countSince(userId, orgId, future)).toBe(0);
    });
  });

  describe("markAsRead", () => {
    it("marks a single notification as read", async () => {
      const notification = await seed();
      const updated = await notificationRepo.markAsRead(notification.id);

      expect(updated.isRead).toBe(true);
    });
  });

  describe("markAllAsRead", () => {
    it("marks every unread notification in the org as read", async () => {
      await seed();
      await seed();

      const result = await notificationRepo.markAllAsRead(userId, orgId);

      expect(result.count).toBe(2);
      expect(await notificationRepo.countUnread(userId, orgId)).toBe(0);
    });

    it("leaves the user's other org untouched", async () => {
      await seed();
      await seed({ organizationId: otherOrgId });

      await notificationRepo.markAllAsRead(userId, orgId);

      expect(await notificationRepo.countUnread(userId, orgId)).toBe(0);
      expect(await notificationRepo.countUnread(userId, otherOrgId)).toBe(1);
    });

    it("leaves other users untouched", async () => {
      await seed();
      await notificationRepo.create({
        userId: otherUserId,
        organizationId: orgId,
        type: "task_assigned",
        title: "Theirs",
        message: "Theirs",
      });

      await notificationRepo.markAllAsRead(userId, orgId);

      expect(await notificationRepo.countUnread(otherUserId, orgId)).toBe(1);
    });

    it("is a no-op when nothing is unread", async () => {
      const result = await notificationRepo.markAllAsRead(userId, orgId);
      expect(result.count).toBe(0);
    });
  });

  describe("findById", () => {
    it("returns the notification", async () => {
      const created = await seed();
      const found = await notificationRepo.findById(created.id);

      expect(found?.id).toBe(created.id);
      expect(found?.organizationId).toBe(orgId);
    });

    it("returns null for an unknown id", async () => {
      expect(await notificationRepo.findById("does-not-exist")).toBeNull();
    });
  });

  describe("existsSince", () => {
    it("is true when a matching notification exists in the org", async () => {
      await seed({ type: "hour_limit_warning", entityId: "membership-1" });
      const since = new Date(Date.now() - 60_000);

      expect(
        await notificationRepo.existsSince(userId, orgId, "hour_limit_warning", since)
      ).toBe(true);
    });

    it("is false for the same type in a different org", async () => {
      await seed({ organizationId: otherOrgId, type: "hour_limit_warning" });
      const since = new Date(Date.now() - 60_000);

      expect(
        await notificationRepo.existsSince(userId, orgId, "hour_limit_warning", since)
      ).toBe(false);
    });

    it("narrows by entityId when given", async () => {
      await seed({ type: "hour_limit_warning", entityId: "membership-1" });
      const since = new Date(Date.now() - 60_000);

      expect(
        await notificationRepo.existsSince(
          userId,
          orgId,
          "hour_limit_warning",
          since,
          "membership-1"
        )
      ).toBe(true);
      expect(
        await notificationRepo.existsSince(
          userId,
          orgId,
          "hour_limit_warning",
          since,
          "membership-2"
        )
      ).toBe(false);
    });

    it("is false for notifications older than the cutoff", async () => {
      await seed({ type: "hour_limit_warning" });
      const since = new Date(Date.now() + 60_000);

      expect(
        await notificationRepo.existsSince(userId, orgId, "hour_limit_warning", since)
      ).toBe(false);
    });
  });
});
