/**
 * Tests for Recurring Task Service (Control Layer)
 *
 * Verifies:
 * - A recurring task expands into real instances linked by parentTaskId
 * - Generation is idempotent (re-running never duplicates occurrences)
 * - Instances are plain tasks (not themselves recurring)
 * - Generation stops at the plan's active-task limit instead of blowing past it
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RecurringTaskService } from "@/services/recurring-task.service";
import { TaskService } from "@/services/task.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { todaySgtAt } from "../helpers/time";
import { dayOfWeekInTimeZone, hourInTimeZone } from "@/lib/timezone";

const recurringService = new RecurringTaskService();
const taskService = new TaskService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let userId: string;

/** A start/end a few hours from now, so occurrences land inside the horizon. */
function soon(offsetDays = 0) {
  // 09:00-13:00 Singapore time. Recurrence preserves the organisation's
  // time-of-day, so the fixture has to state which timezone it means.
  const start = todaySgtAt(9, offsetDays);
  const end = todaySgtAt(13, offsetDays);
  return { start: start.toISOString(), end: end.toISOString() };
}

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create({ name: "Acme Corp", slug: "acme-corp" }, user.id);
  orgId = org.id;

  await prisma.companySettings.create({ data: { organizationId: orgId } });
});

/** Creates a recurring series. Note: create() auto-generates its instances. */
async function createSeries(pattern: object, offsetDays = 0) {
  const { start, end } = soon(offsetDays);
  return taskService.create(
    {
      title: "Morning shift",
      location: "Main kitchen",
      instructions: "Complete the opening checklist.",
      requiredCertifications: ["Food Safety"],
      scheduledStart: start,
      scheduledEnd: end,
      isRecurring: true,
      recurringPattern: JSON.stringify(pattern),
    },
    orgId,
    userId
  );
}

describe("RecurringTaskService", () => {
  describe("generation", () => {
    it("expands a daily series into instances linked to the parent", async () => {
      const template = await createSeries({ freq: "daily", interval: 1 });

      const instances = await prisma.task.findMany({
        where: { parentTaskId: template.id },
        orderBy: { scheduledStart: "asc" },
      });

      // 14-day horizon from today, minus the template's own occurrence.
      expect(instances.length).toBeGreaterThan(5);

      // Instances are ordinary tasks — only the template carries the pattern.
      for (const inst of instances) {
        expect(inst.isRecurring).toBe(false);
        expect(inst.recurringPattern).toBeNull();
        expect(inst.parentTaskId).toBe(template.id);
        expect(inst.title).toBe("Morning shift");
        expect(inst.location).toBe("Main kitchen");
        expect(inst.instructions).toBe("Complete the opening checklist.");
        expect(inst.requiredCertifications).toEqual(["Food Safety"]);
      }
    });

    it("preserves the time-of-day and duration on each occurrence", async () => {
      const template = await createSeries({ freq: "daily", interval: 1 });

      const instance = await prisma.task.findFirst({
        where: { parentTaskId: template.id },
      });

      expect(hourInTimeZone(instance!.scheduledStart!)).toBe(9);
      const durationMs =
        instance!.scheduledEnd!.getTime() - instance!.scheduledStart!.getTime();
      expect(durationMs).toBe(4 * 60 * 60 * 1000);
    });

    it("only generates on the chosen weekdays", async () => {
      const template = await createSeries({
        freq: "weekly",
        interval: 1,
        days: [1, 3], // Mon + Wed
      });

      const instances = await prisma.task.findMany({
        where: { parentTaskId: template.id },
      });

      for (const inst of instances) {
        expect([1, 3]).toContain(dayOfWeekInTimeZone(inst.scheduledStart!));
      }
    });

    it("is idempotent — a second run creates nothing new", async () => {
      const template = await createSeries({ freq: "daily", interval: 1 });

      const countAfterCreate = await prisma.task.count({
        where: { parentTaskId: template.id },
      });

      const result = await recurringService.generateForOrganization(orgId, 14, userId);

      expect(result.created).toBe(0);
      expect(result.skippedExisting).toBeGreaterThan(0);

      const countAfterRerun = await prisma.task.count({
        where: { parentTaskId: template.id },
      });
      expect(countAfterRerun).toBe(countAfterCreate);
    });

    it("extends the series when the horizon grows", async () => {
      const template = await createSeries({ freq: "daily", interval: 1 });

      const before = await prisma.task.count({
        where: { parentTaskId: template.id },
      });

      // Push the horizon out — new occurrences appear, old ones are untouched.
      const result = await recurringService.generateForOrganization(orgId, 25, userId);

      expect(result.created).toBeGreaterThan(0);
      const after = await prisma.task.count({
        where: { parentTaskId: template.id },
      });
      expect(after).toBeGreaterThan(before);
    });

    it("ignores a task whose pattern is unreadable", async () => {
      // Written straight to the DB — create() would reject this.
      const { start, end } = soon();
      await prisma.task.create({
        data: {
          title: "Broken series",
          organizationId: orgId,
          createdById: userId,
          scheduledStart: new Date(start),
          scheduledEnd: new Date(end),
          isRecurring: true,
          recurringPattern: "not-json",
        },
      });

      const result = await recurringService.generateForOrganization(orgId, 14, userId);
      expect(result.created).toBe(0);
      expect(result.seriesProcessed).toBe(0);
    });
  });

  describe("subscription limits", () => {
    it("stops at the plan's active-task limit rather than exceeding it", async () => {
      // Free tier allows 20 active tasks. A daily series over a 60-day horizon
      // wants far more than that.
      const { start, end } = soon();
      const template = await prisma.task.create({
        data: {
          title: "Daily shift",
          organizationId: orgId,
          createdById: userId,
          scheduledStart: new Date(start),
          scheduledEnd: new Date(end),
          isRecurring: true,
          recurringPattern: JSON.stringify({ freq: "daily", interval: 1 }),
        },
      });

      const result = await recurringService.generateForOrganization(orgId, 60, userId);

      expect(result.limitReached).toBe(true);
      expect(result.skippedAtLimit).toBeGreaterThan(0);

      // Total active tasks (template + instances) must not exceed the free cap.
      const activeTasks = await prisma.task.count({
        where: {
          organizationId: orgId,
          status: { notIn: ["completed", "cancelled"] },
        },
      });
      expect(activeTasks).toBeLessThanOrEqual(20);
      expect(template.id).toBeTruthy();
    });
  });

  describe("validation via TaskService.create", () => {
    it("rejects a recurring task with no schedule", async () => {
      await expect(
        taskService.create(
          {
            title: "Bad series",
            isRecurring: true,
            recurringPattern: JSON.stringify({ freq: "daily", interval: 1 }),
          },
          orgId,
          userId
        )
      ).rejects.toThrow("must have a start and end time");
    });

    it("rejects a recurring task with an invalid pattern", async () => {
      const { start, end } = soon();
      await expect(
        taskService.create(
          {
            title: "Bad series",
            scheduledStart: start,
            scheduledEnd: end,
            isRecurring: true,
            recurringPattern: "garbage",
          },
          orgId,
          userId
        )
      ).rejects.toThrow("Invalid recurrence pattern");
    });
  });
});
