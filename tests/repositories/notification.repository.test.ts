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
import { prisma } from "@/lib/prisma";

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

      expect(counts.all["task_assigned"]).toBe(2);
      expect(counts.all["cert_verified"]).toBe(1);
    });

    it("returns an empty object when there are none", async () => {
      expect(await notificationRepo.countByType(userId, orgId)).toEqual({
        all: {},
        unread: {},
      });
    });

    /*
     * The unread half, which is what "Needs action" is summed from.
     *
     * That tile used the all-time counts, so a rejection read months ago kept
     * contributing to a number telling you something was waiting — it never
     * went down as you dealt with things, which is the only behaviour it
     * needed.
     */
    it("counts the unread ones separately, from the same rows", async () => {
      await seed({ type: "assignment_rejected" });
      const read = await seed({ type: "assignment_rejected" });
      await notificationRepo.markAsRead(read.id);

      const counts = await notificationRepo.countByType(userId, orgId);

      expect(counts.all["assignment_rejected"]).toBe(2);
      expect(counts.unread["assignment_rejected"]).toBe(1);
    });

    it("omits a type entirely from unread once everything is read", async () => {
      const only = await seed({ type: "hour_limit_warning" });
      await notificationRepo.markAsRead(only.id);

      const counts = await notificationRepo.countByType(userId, orgId);

      expect(counts.all["hour_limit_warning"]).toBe(1);
      expect(counts.unread["hour_limit_warning"]).toBeUndefined();
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

/**
 * Paging over a feed that grows at the head.
 *
 * Offset paging asked for "twenty rows in", so three notifications arriving
 * between page one and "load older" shifted every row down three places —
 * re-serving rows already on screen and skipping three that were never shown.
 * On a page whose whole job is "have I missed anything", dropping rows silently
 * is the wrong failure.
 */
describe("keyset paging", () => {
  /** Rows written far enough apart to have distinct timestamps. */
  async function page(size: number, cursor?: { createdAt: Date; id: string }) {
    return notificationRepo.findByUserId(userId, orgId, size, 0, {}, cursor);
  }

  it("continues from the row it was given, not from a position", async () => {
    for (let i = 0; i < 6; i++) await seed({ title: `Notice ${i}` });

    const first = await page(3);
    const last = first[first.length - 1];

    // Three more arrive at the head while the reader is reading.
    for (let i = 0; i < 3; i++) await seed({ title: `Late ${i}` });

    const second = await page(3, { createdAt: last.createdAt, id: last.id });

    const overlap = second.filter((n) => first.some((f) => f.id === n.id));
    expect(overlap, "a row was served twice").toEqual([]);
    expect(second.map((n) => n.title)).toEqual(["Notice 2", "Notice 1", "Notice 0"]);
  });

  /*
   * The tie case, and the reason the cursor carries the id as well.
   * `createdAt` is `timestamp(3)`, and one action notifying several people
   * writes them in the same millisecond routinely — a cursor on the timestamp
   * alone would skip the rest of a tied group.
   */
  it("does not skip rows sharing the cursor's timestamp", async () => {
    const sameInstant = new Date();
    for (let i = 0; i < 4; i++) {
      await prisma.notification.create({
        data: {
          userId,
          organizationId: orgId,
          type: "task_assigned",
          title: `Tied ${i}`,
          message: "Same millisecond",
          createdAt: sameInstant,
        },
      });
    }

    const first = await page(2);
    const last = first[first.length - 1];
    const second = await page(2, { createdAt: last.createdAt, id: last.id });

    const ids = [...first, ...second].map((n) => n.id);
    expect(new Set(ids).size, "a tied row was served twice").toBe(4);
  });

  it("returns nothing once the cursor reaches the oldest row", async () => {
    await seed({ title: "Only one" });
    const [only] = await page(5);

    expect(await page(5, { createdAt: only.createdAt, id: only.id })).toEqual([]);
  });

  // The cursor must not widen the filter it is paging through.
  it("keeps the filter applied while paging", async () => {
    for (let i = 0; i < 3; i++) await seed({ type: "cert_expiring" });
    for (let i = 0; i < 3; i++) await seed({ type: "task_assigned" });

    const first = await notificationRepo.findByUserId(userId, orgId, 2, 0, {
      types: ["cert_expiring"],
    });
    const last = first[first.length - 1];
    const second = await notificationRepo.findByUserId(
      userId,
      orgId,
      5,
      0,
      { types: ["cert_expiring"] },
      { createdAt: last.createdAt, id: last.id }
    );

    expect(second.every((n) => n.type === "cert_expiring")).toBe(true);
    expect(first.length + second.length).toBe(3);
  });
});
