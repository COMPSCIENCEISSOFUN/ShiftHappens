/**
 * Tests for Auto-Schedule Service (Control Layer)
 *
 * Covers the algorithmic schedule generation (deterministic fallback),
 * schedule confirmation, and edge cases. AI path is not tested
 * since it requires external API keys — the algorithmic fallback
 * is the safety net and must be rock-solid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import bcrypt from "bcryptjs";
import { atHourSgt, nextMondaySgt } from "../helpers/time";

let orgId: string;
let adminUserId: string;
let staffMembershipIds: string[];
let deptId: string;

beforeEach(async () => {
  await cleanDatabase();

  const hashedPassword = await bcrypt.hash("TestPass1!", 12);

  const admin = await prisma.user.create({
    data: { name: "Admin", email: "admin@test.com", hashedPassword, emailVerified: new Date() },
  });
  adminUserId = admin.id;

  const org = await prisma.organization.create({
    data: { name: "Test Org", slug: "test-org" },
  });
  orgId = org.id;

  await prisma.membership.create({
    data: { userId: admin.id, organizationId: orgId, role: "company_admin", status: "active" },
  });

  // Stated rather than inherited: the column default became "auto" on
  // 2026-08-13, and these tests drive the scheduler directly — a second,
  // implicit allocation on every task create is not what they are measuring.
  await prisma.companySettings.create({
    data: { organizationId: orgId, allocationMode: "suggested" },
  });

  const dept = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  deptId = dept.id;

  // Create 3 staff with availability
  staffMembershipIds = [];
  const staffData = [
    { name: "Staff A", email: "a@test.com" },
    { name: "Staff B", email: "b@test.com" },
    { name: "Staff C", email: "c@test.com" },
  ];

  for (const s of staffData) {
    const user = await prisma.user.create({
      data: { name: s.name, email: s.email, hashedPassword, emailVerified: new Date() },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: orgId, role: "staff", status: "active" },
    });
    staffMembershipIds.push(membership.id);

    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptId },
    });

    // Available Mon-Fri 6am-6pm
    for (let d = 1; d <= 5; d++) {
      await prisma.availability.create({
        data: { membershipId: membership.id, dayOfWeek: d, startTime: "06:00", endTime: "18:00", isAvailable: true },
      });
    }
  }
});

describe("AutoScheduleService", () => {
  describe("generateSchedule", () => {
    it("returns empty when no tasks need staffing", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();

      const draft = await service.generateSchedule(orgId, weekStart);

      expect(draft.assignments).toEqual([]);
      expect(draft.unfilledTasks).toEqual([]);
      expect(draft.summary.totalTasks).toBe(0);
    });

    it("assigns staff to open tasks for the week", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1); // Tuesday

      await prisma.task.create({
        data: {
          title: "Test Task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 2,
          scheduledStart: setHour(taskDate, 8),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);

      // Should have assignments (AI or algorithmic)
      expect(draft.assignments.length).toBeGreaterThanOrEqual(1);
      expect(draft.summary.totalTasks).toBe(1);
    });

    it("skips fully staffed tasks", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      const task = await prisma.task.create({
        data: {
          title: "Full Task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 11),
          createdById: adminUserId,
        },
      });

      // Already assigned
      await prisma.taskAssignment.create({
        data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "accepted" },
      });

      const draft = await service.generateSchedule(orgId, weekStart);
      expect(draft.summary.totalTasks).toBe(0);
    });

    it("skips tasks outside the selected week", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();

      // Task 2 weeks from now
      const futureDate = new Date(weekStart);
      futureDate.setDate(futureDate.getDate() + 14);

      await prisma.task.create({
        data: {
          title: "Future Task",
          organizationId: orgId,
          priority: "medium",
          requiredHeadcount: 1,
          scheduledStart: setHour(futureDate, 9),
          scheduledEnd: setHour(futureDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);
      expect(draft.summary.totalTasks).toBe(0);
    });

    it("reports unfilled tasks when not enough staff", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      await prisma.task.create({
        data: {
          title: "Big Task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 10,
          scheduledStart: setHour(taskDate, 8),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);

      expect(draft.unfilledTasks.length).toBe(1);
      expect(draft.unfilledTasks[0].taskTitle).toBe("Big Task");
    });

    it("does not double-book staff across overlapping tasks", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      // Two overlapping tasks, each needing 3 staff (only 3 available)
      await prisma.task.create({
        data: {
          title: "Task A",
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 3,
          scheduledStart: setHour(taskDate, 8),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      await prisma.task.create({
        data: {
          title: "Task B",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 3,
          scheduledStart: setHour(taskDate, 10),
          scheduledEnd: setHour(taskDate, 14),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);

      // All 3 staff should go to Task A (higher priority)
      // Task B should be unfilled or partially filled
      const taskAAssignments = draft.assignments.filter((a) => a.taskTitle === "Task A");
      const taskBAssignments = draft.assignments.filter((a) => a.taskTitle === "Task B");

      expect(taskAAssignments.length).toBe(3);
      expect(taskBAssignments.length).toBe(0);
      expect(draft.unfilledTasks.length).toBe(1);
    });

    it("distributes hours fairly across staff", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();

      // Create 3 non-overlapping tasks, each needing 1 staff
      for (let i = 0; i < 3; i++) {
        const taskDate = new Date(weekStart);
        taskDate.setDate(taskDate.getDate() + 1 + i); // Tue, Wed, Thu

        await prisma.task.create({
          data: {
            title: `Task ${i + 1}`,
            organizationId: orgId,
            departmentId: deptId,
            priority: "medium",
            requiredHeadcount: 1,
            scheduledStart: setHour(taskDate, 9),
            scheduledEnd: setHour(taskDate, 12),
            createdById: adminUserId,
          },
        });
      }

      const draft = await service.generateSchedule(orgId, weekStart);

      expect(draft.assignments.length).toBe(3);

      // Each staff member should get 1 task (fairness)
      const staffNames = draft.assignments.map((a) => a.staffName);
      const unique = new Set(staffNames);
      expect(unique.size).toBe(3);
    });
  });

  describe("confirmSchedule", () => {
    it("creates assignments in batch", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      const task = await prisma.task.create({
        data: {
          title: "Confirm Test",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 2,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const result = await service.confirmSchedule(orgId, [
        { taskId: task.id, taskTitle: task.title, membershipId: staffMembershipIds[0], staffName: "Staff A", reasoning: "test" },
        { taskId: task.id, taskTitle: task.title, membershipId: staffMembershipIds[1], staffName: "Staff B", reasoning: "test" },
      ], adminUserId);

      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
    });

    /**
     * A draft referencing a task that does not exist must be counted as failed
     * rather than aborting the whole confirmation — one bad row should not cost
     * the user the other nineteen.
     *
     * The console.error spy asserts the second half of that contract: the
     * failure is reported, not silently absorbed into a count. It also keeps the
     * deliberate Prisma error out of the suite's stderr.
     */
    it("handles failures gracefully", async () => {
      // This used to reach the per-row try/catch: an unknown taskId was handed
      // straight to the repository and the foreign-key violation was logged as
      // "[Auto-Schedule] Failed". confirmSchedule now validates every id against
      // the organisation BEFORE writing anything, so an id this org does not own
      // — whether it belongs to another tenant or to nothing at all — is refused
      // up front and never reaches the database. The outcome the caller sees is
      // unchanged; only the log line and the reason differ.
      const service = new AutoScheduleService();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const result = await service.confirmSchedule(orgId, [
          { taskId: "nonexistent", taskTitle: "Bad", membershipId: staffMembershipIds[0], staffName: "Staff A", reasoning: "test" },
        ], adminUserId);

        expect(result.created).toBe(0);
        expect(result.failed).toBe(1);

        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining("[Auto-Schedule] Refused cross-tenant draft row")
        );
      } finally {
        logged.mockRestore();
      }
    });

    it("does not abort the batch when one row is refused", async () => {
      // The property the original test was really protecting: one bad row must
      // not cost the good ones. Asserted directly now that refusal happens
      // before the write rather than during it.
      const service = new AutoScheduleService();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);
      const good = await prisma.task.create({
        data: {
          title: "Good task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      try {
        const result = await service.confirmSchedule(orgId, [
          { taskId: "nonexistent", taskTitle: "Bad", membershipId: staffMembershipIds[0], staffName: "Staff A", reasoning: "test" },
          { taskId: good.id, taskTitle: "Good", membershipId: staffMembershipIds[0], staffName: "Staff A", reasoning: "test" },
        ], adminUserId);

        expect(result.created).toBe(1);
        expect(result.rejected).toBe(1);
      } finally {
        logged.mockRestore();
      }
    });
  });
});

// Helpers
// Weekday and midnight resolved in the organisation's timezone. The runner's
// clock would place these fixtures on a different day, and the scheduler now
// matches availability using Singapore time — so nothing matched at all.
function getNextMonday(): Date {
  return nextMondaySgt();
}

function setHour(date: Date, hour: number): Date {
  return atHourSgt(date, hour);
}
/**
 * The draft used to be built by a SECOND implementation of the eligibility
 * rules, weaker than the real one in ways nobody had noticed:
 *
 *   - the daily cap read `taskDuration > rule.maxHours` — one shift's length
 *     against the limit, never the day's total
 *   - rest gaps were not consulted at all
 *   - certifications were not checked
 *   - and the AI path, which `generateSchedule` PREFERS, checked only that the
 *     model had named a real task and a real person without exceeding headcount
 *
 * Both paths now go through `checkEligibilityForTask`, with the draft so far
 * passed in as provisional, so a shift decided earlier in the same run counts
 * against the ones decided after it.
 */
describe("a generated draft obeys the same rules as the assign screen", () => {
  /**
   * Two 6-hour shifts on the same Tuesday, both INSIDE the 06:00-18:00
   * availability the fixture gives every member.
   *
   * That detail is the test. The first version used 07:00-13:00 and
   * 13:00-19:00, and 19:00 falls outside the window — so the second shift was
   * refused on availability and the assertions passed without the daily cap or
   * the rest gap ever being consulted. Mutation testing caught it: deleting the
   * provisional-hours logic entirely changed nothing.
   */
  async function twoSameDayShifts(hours: [number, number][] = [[6, 12], [12, 18]]) {
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    for (const [from, to] of hours) {
      await prisma.task.create({
        data: {
          title: `Shift ${from}-${to}`,
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, from),
          scheduledEnd: setHour(taskDate, to),
          createdById: adminUserId,
        },
      });
    }
    return weekStart;
  }

  /** Everyone but one member unavailable, so the draft has no choice but to stack. */
  async function leaveOnlyOneCandidate() {
    for (const membershipId of staffMembershipIds.slice(1)) {
      await prisma.availability.deleteMany({ where: { membershipId } });
    }
  }

  /**
   * The daily-cap gap. `taskDuration > maxHours` is false for each 6-hour
   * shift taken alone, so the old check waved both through and the one
   * available member was drafted for 12 hours under an 8-hour cap.
   */
  it("does not stack two shifts past a daily cap", async () => {
    await prisma.workRule.create({
      data: {
        organizationId: orgId,
        name: "Daily cap",
        type: "max_hours_daily",
        maxHours: 8,
        isActive: true,
      },
    });
    await leaveOnlyOneCandidate();
    const weekStart = await twoSameDayShifts();

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    const forTheOne = draft.assignments.filter(
      (a) => a.membershipId === staffMembershipIds[0]
    );
    expect(forTheOne).toHaveLength(1);
    expect(draft.unfilledTasks).toHaveLength(1);
  });

  /**
   * Rest gaps had no effect on a generated week at all — `break_interval` was
   * simply not among the rule types the draft looked at.
   */
  it("respects a rest gap between shifts it schedules", async () => {
    await prisma.workRule.create({
      data: {
        organizationId: orgId,
        name: "Daily rest",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 11,
        isActive: true,
      },
    });
    await leaveOnlyOneCandidate();
    // 07:00-13:00 then 13:00-19:00: six hours each, no rest between them.
    const weekStart = await twoSameDayShifts();

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    expect(
      draft.assignments.filter((a) => a.membershipId === staffMembershipIds[0])
    ).toHaveLength(1);
  });

  /**
   * Certifications were not consulted by either draft path, so a generated
   * week could put an uncertified member on a shift the assign screen would
   * have refused.
   */
  it("does not draft someone who lacks a required certification", async () => {
    await leaveOnlyOneCandidate();
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    await prisma.task.create({
      data: {
        title: "Needs a ticket",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        requiredCertifications: ["Food Safety"],
        scheduledStart: setHour(taskDate, 8),
        scheduledEnd: setHour(taskDate, 12),
        createdById: adminUserId,
      },
    });

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    expect(draft.assignments).toHaveLength(0);
    expect(draft.unfilledTasks).toHaveLength(1);
  });

  it("drafts them once they hold it", async () => {
    await leaveOnlyOneCandidate();
    await prisma.certification.create({
      data: {
        membershipId: staffMembershipIds[0],
        name: "Food Safety",
        status: "verified",
        issuedDate: new Date("2026-01-01"),
        expiryDate: new Date("2027-01-01"),
      },
    });
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    await prisma.task.create({
      data: {
        title: "Needs a ticket",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        requiredCertifications: ["Food Safety"],
        scheduledStart: setHour(taskDate, 8),
        scheduledEnd: setHour(taskDate, 12),
        createdById: adminUserId,
      },
    });

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    expect(draft.assignments).toHaveLength(1);
  });

  /**
   * Hours already committed in the database count alongside the draft's own.
   *
   * This is the realistic case — a week is rarely generated onto an empty
   * roster — and it is the one where the two sources have to be summed rather
   * than either taken alone.
   */
  it("counts committed shifts as well as drafted ones", async () => {
    await prisma.workRule.create({
      data: {
        organizationId: orgId,
        name: "Weekly cap",
        type: "max_hours_weekly",
        maxHours: 10,
        isActive: true,
      },
    });
    await leaveOnlyOneCandidate();

    const weekStart = getNextMonday();
    const monday = new Date(weekStart);
    const committed = await prisma.task.create({
      data: {
        title: "Already on the books",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        scheduledStart: setHour(monday, 8),
        scheduledEnd: setHour(monday, 14), // six hours
        createdById: adminUserId,
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: committed.id,
        membershipId: staffMembershipIds[0],
        assignedById: adminUserId,
        status: "accepted",
      },
    });

    await twoSameDayShifts();

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    // Six committed + six drafted is twelve, past the ten-hour week, so neither
    // of the two new shifts can be taken.
    expect(
      draft.assignments.filter((a) => a.membershipId === staffMembershipIds[0])
    ).toHaveLength(0);
  });

  /**
   * The provisional set must not leak between runs. If it did, a second
   * generation would see the first one's decisions as commitments and refuse
   * work that is still unassigned.
   */
  it("starts each generation from a clean draft", async () => {
    await leaveOnlyOneCandidate();
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    await prisma.task.create({
      data: {
        title: "Only shift",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        scheduledStart: setHour(taskDate, 8),
        scheduledEnd: setHour(taskDate, 12),
        createdById: adminUserId,
      },
    });

    const service = new AutoScheduleService();
    const first = await service.generateSchedule(orgId, weekStart);
    const second = await service.generateSchedule(orgId, weekStart);

    expect(first.assignments).toHaveLength(1);
    expect(second.assignments).toHaveLength(1);
  });
});

/**
 * The AI path, which nothing tested and which `generateSchedule` PREFERS.
 *
 * `parseAIResponse` checked that the model had named a real task and a real
 * person and had not exceeded headcount. It checked nothing else — so the
 * default output could roster someone unavailable, uncertified, double-booked
 * or over their cap, and the first anyone heard of it was the confirm failing.
 *
 * The model is stubbed rather than called; what is under test is what happens
 * to its answer, not the answer itself.
 */
describe("the AI draft is screened too", () => {
  function mockGroq(picks: { task: number; staff: string; reason: string }[]) {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(picks) } }],
        }),
      })
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
  });

  it("drops a pick the engine refuses, rather than trusting the model", async () => {
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    await prisma.task.create({
      data: {
        title: "Needs a ticket",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        requiredCertifications: ["Food Safety"],
        scheduledStart: setHour(taskDate, 8),
        scheduledEnd: setHour(taskDate, 12),
        createdById: adminUserId,
      },
    });
    // Nobody holds the certificate, and the model picks someone anyway.
    mockGroq([{ task: 1, staff: "A", reason: "Looks free" }]);

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    expect(draft.assignments).toHaveLength(0);
    expect(draft.unfilledTasks).toHaveLength(1);
  });

  it("keeps a pick the engine allows", async () => {
    await prisma.certification.create({
      data: {
        membershipId: staffMembershipIds[0],
        name: "Food Safety",
        status: "verified",
        issuedDate: new Date("2026-01-01"),
        expiryDate: new Date("2027-01-01"),
      },
    });
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    await prisma.task.create({
      data: {
        title: "Needs a ticket",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        requiredCertifications: ["Food Safety"],
        scheduledStart: setHour(taskDate, 8),
        scheduledEnd: setHour(taskDate, 12),
        createdById: adminUserId,
      },
    });
    mockGroq([{ task: 1, staff: "A", reason: "Certified and free" }]);

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    expect(draft.assignments).toHaveLength(1);
    expect(draft.provider).toBe("groq");
  });

  /**
   * The model listing one person on two overlapping shifts is the case the
   * provisional set exists for on this path — the second is refused because
   * the first has already been accepted in the same run.
   */
  it("refuses the second of two overlapping picks for the same person", async () => {
    const weekStart = getNextMonday();
    const taskDate = new Date(weekStart);
    taskDate.setDate(taskDate.getDate() + 1);
    for (const [from, to] of [[8, 12], [10, 14]]) {
      await prisma.task.create({
        data: {
          title: `Shift ${from}`,
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, from),
          scheduledEnd: setHour(taskDate, to),
          createdById: adminUserId,
        },
      });
    }
    mockGroq([
      { task: 1, staff: "A", reason: "free" },
      { task: 2, staff: "A", reason: "also free" },
    ]);

    const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

    expect(
      draft.assignments.filter((a) => a.membershipId === staffMembershipIds[0])
    ).toHaveLength(1);
  });
});
