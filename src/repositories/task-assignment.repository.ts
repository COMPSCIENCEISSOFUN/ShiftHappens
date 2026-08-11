/**
 * TaskAssignment Repository (Entity Layer)
 * 
 * Data access layer for task assignment operations.
 * Handles assignment creation, status transitions
 * (pending → accepted → clocked in → completed),
 * rejection with reason, and clock in/out tracking.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";
import {
  occupyingStatusFilter,
  RELEASED_STATUSES,
  WORKED_STATUSES,
} from "@/lib/assignment-status";
import type { ShiftOutcome } from "@/lib/shift-outcome";


/** What a caller may narrow a member's history by. */
export interface HistoryFilters {
  from?: Date;
  to?: Date;
  departmentId?: string;
  search?: string;
  outcome?: ShiftOutcome;
}

/*
 * `shiftOutcome` decided in application code; this decides the same thing in
 * SQL. Two implementations of one rule, which is a drift risk worth naming.
 *
 * They are not shared, and could not easily be: `shift-outcome.ts` is imported
 * by the browser, and giving it Prisma types would drag the server's client
 * into the page bundle. The alternative — classifying in application code —
 * would mean fetching the whole history to filter it, which breaks paging and
 * makes the totals describe a different set of rows than the list.
 *
 * So instead of sharing the code, the suite proves the two agree:
 * `shift-history-filters.test.ts` filters by every outcome in turn, classifies
 * each returned row with `shiftOutcome`, and asserts the counts partition the
 * unfiltered total exactly. A disagreement between these two definitions cannot
 * survive that.
 */

/** Worked: a terminal worked status, or a clock-out however the row is marked. */
const WORKED_WHERE = {
  OR: [
    { status: { in: [...WORKED_STATUSES] } },
    { clockOutTime: { not: null } },
  ],
};

/** Its exact negation, needed by every outcome below `worked` in the order. */
const NOT_WORKED_WHERE = {
  status: { notIn: [...WORKED_STATUSES] },
  clockOutTime: null,
};

/**
 * The precedence in `shiftOutcome` is the whole content of that function, so it
 * is the whole content of this one too: each outcome excludes everything that
 * outranks it. Without those exclusions the filters would overlap — a cancelled
 * shift somebody worked would come back under both "Worked" and "Cancelled",
 * and the partition test is what makes that impossible to ship.
 */
function outcomeWhere(outcome: ShiftOutcome) {
  const notReleased = { status: { notIn: ["rejected", "withdrawn"] } };
  const notCancelled = { task: { status: { not: "cancelled" } } };

  switch (outcome) {
    case "worked":
      return WORKED_WHERE;
    case "declined":
      return { ...NOT_WORKED_WHERE, status: "rejected" };
    case "withdrawn":
      return { ...NOT_WORKED_WHERE, status: "withdrawn" };
    case "cancelled":
      return {
        AND: [NOT_WORKED_WHERE, notReleased, { task: { status: "cancelled" } }],
      };
    case "not_clocked_out":
      return {
        AND: [
          NOT_WORKED_WHERE,
          notReleased,
          notCancelled,
          { clockInTime: { not: null } },
        ],
      };
    case "unanswered":
      return {
        AND: [
          NOT_WORKED_WHERE,
          notReleased,
          notCancelled,
          { clockInTime: null },
          { status: { in: ["pending", "decline_requested"] } },
        ],
      };
    case "no_clock_in":
      return {
        AND: [
          NOT_WORKED_WHERE,
          notReleased,
          notCancelled,
          { clockInTime: null },
          { status: { notIn: ["pending", "decline_requested"] } },
        ],
      };
  }
}

export class TaskAssignmentRepository {
  /** Creates a new task assignment with pending status */
  /**
   * The department of an assignment's task, for scope checks. Same tri-state as
   * TaskRepository.getDepartmentId: `undefined` = no such assignment.
   */
  async getTaskDepartmentId(id: string): Promise<string | null | undefined> {
    const assignment = await prisma.taskAssignment.findUnique({
      where: { id },
      select: { task: { select: { departmentId: true } } },
    });
    return assignment === null ? undefined : assignment.task.departmentId;
  }

  async create(data: {
    taskId: string;
    membershipId: string;
    assignedById: string;
    status?: string;
    /** See src/lib/allocation-provenance.ts. Omitted means "not recorded". */
    allocationSource?: string;
    allocationProvider?: string;
    allocationScore?: number;
    allocationRank?: number;
  }) {
    return prisma.taskAssignment.create({
      data: {
        taskId: data.taskId,
        membershipId: data.membershipId,
        assignedById: data.assignedById,
        status: data.status ?? "pending",
        // Prisma treats undefined as "leave alone", which on a create means
        // the column stays NULL — exactly the "not recorded" state wanted for
        // any caller that does not know how the choice was made.
        allocationSource: data.allocationSource,
        allocationProvider: data.allocationProvider,
        allocationScore: data.allocationScore,
        allocationRank: data.allocationRank,
      },
    });
  }

  /** Finds an assignment by ID with full task and user details */
  async findById(id: string) {
    return prisma.taskAssignment.findUnique({
      where: { id },
      include: {
        task: {
          include: {
            department: { select: { id: true, name: true, color: true } },
          },
        },
        membership: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
    });
  }

  /** Lists all assignments for a specific task */
  async findByTaskId(taskId: string) {
    return prisma.taskAssignment.findMany({
      where: { taskId },
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * Lists all assignments for a member, optionally filtered by status.
   * Used for staff viewing their assigned tasks (US-56).
   */
  /**
   * A member's shifts inside a date window, for the calendar feed.
   *
   * Its own method rather than filtering `findByMembershipId` in the service,
   * which is what this did first: that returns EVERY assignment the person has
   * ever held, with two joins, and the service then dropped most of them. On an
   * endpoint that takes no session and is polled hourly by every subscriber,
   * a query that grows with someone's length of service is the wrong shape —
   * and the rows it was discarding were the ones it had paid most to fetch.
   *
   * Status is filtered here too, through `occupyingStatusFilter` — the same
   * rule the headcount uses. A rejected shift is not one this person has.
   */
  async findForCalendarFeed(membershipId: string, from: Date, until: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: occupyingStatusFilter() },
        task: {
          scheduledStart: { gte: from, lte: until },
          scheduledEnd: { not: null },
        },
      },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            description: true,
            scheduledStart: true,
            scheduledEnd: true,
            department: { select: { name: true } },
          },
        },
      },
      // Deterministic, like every other list here: equal start times need a
      // tiebreak or the same fetch can order two shifts differently.
      orderBy: [{ task: { scheduledStart: "asc" } }, { id: "asc" }],
    });
  }

  async findByMembershipId(membershipId: string, status?: string) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        ...(status && { status }),
      },
      include: {
        task: {
          include: {
            department: { select: { id: true, name: true, color: true } },
            createdBy: { select: { id: true, name: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  /**
   * Writes a corrected clock pair, and the record that it was corrected.
   *
   * `undefined` is not usable here — Prisma reads it as "leave alone", and
   * clearing a wrongly-entered clock-in back to nothing is a legitimate
   * correction. So both times are required and `null` is how you erase one.
   */
  async correctClock(
    id: string,
    data: {
      clockInTime: Date | null;
      clockOutTime: Date | null;
      correctedById: string;
      reason: string;
    }
  ) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        clockInTime: data.clockInTime,
        clockOutTime: data.clockOutTime,
        clockCorrectedAt: new Date(),
        clockCorrectedById: data.correctedById,
        clockCorrectionReason: data.reason,
      },
    });
  }

  /** Updates an assignment's status */
  async updateStatus(id: string, status: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status },
    });
  }

  /**
   * A staff member accepting an offered assignment.
   *
   * Separate from `updateStatus("accepted")` because `acceptedAt` must record
   * the staff member's answer and nothing else. `denyWithdrawal` also returns
   * a row to "accepted", and stamping it there would rewrite the original
   * response time every time a manager refused someone's request to drop out.
   */
  async accept(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "accepted", acceptedAt: new Date() },
    });
  }

  /** Rejects an assignment with a required reason */
  async reject(id: string, reason: string, notes?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "rejected",
        rejectionReason: reason,
        rejectionNotes: notes,
        rejectedAt: new Date(),
      },
    });
  }

  /**
   * A full-time member's request to be taken off a shift they were rostered
   * onto but had not accepted.
   *
   * Stored in the rejection columns rather than new ones: this IS a rejection,
   * held pending a manager's agreement, and if it is approved the row must
   * already carry the reason the member gave. Duplicating the columns would
   * mean copying values across on approval and leaving two places where a
   * decline reason could live.
   *
   * `rejectedAt` stays NULL — nothing has been rejected yet. `approveDecline`
   * stamps it, so the response-time figures still measure the member's answer
   * rather than the manager's.
   */
  async requestDecline(id: string, reason: string, notes?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "decline_requested",
        rejectionReason: reason,
        // null, not undefined — Prisma ignores undefined, so a second request
        // without notes would silently keep the first request's notes.
        rejectionNotes: notes ?? null,
      },
    });
  }

  /**
   * Manager agrees: the decline takes effect and the slot is freed.
   *
   * Reason and notes are already on the row from `requestDecline` and are left
   * untouched — the member's words, not the manager's.
   */
  async approveDecline(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "rejected", rejectedAt: new Date() },
    });
  }

  /**
   * Manager refuses: back to pending, NOT to accepted.
   *
   * The member is expected on the shift and still has to answer for
   * themselves. Reverting to "accepted" would have the system record an
   * acceptance the member never gave, which is the reason this flow does not
   * reuse the withdrawal statuses.
   *
   * Reason and notes are cleared: they described a request that was refused,
   * and leaving them would make a later genuine decline look like a repeat.
   */
  async denyDecline(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "pending",
        rejectionReason: null,
        rejectionNotes: null,
      },
    });
  }

  /** Records clock-in time for an accepted assignment */
  async clockIn(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { clockInTime: new Date() },
    });
  }

  /**
   * Records clock-out time and moves the assignment to "clocked_out".
   * The shift is worked but not yet confirmed done — the staff member
   * explicitly marks it completed afterwards (see `complete`).
   */
  async clockOut(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        clockOutTime: new Date(),
        status: "clocked_out",
      },
    });
  }

  /** Marks a clocked-out assignment as completed (staff confirmation). */
  async complete(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "completed" },
    });
  }

  /** Records a staff withdrawal request with a reason. Slot stays reserved. */
  async requestWithdrawal(id: string, reason: string, notes?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "withdrawal_requested",
        withdrawalReason: reason,
        // null, not undefined: Prisma ignores undefined, so a second request
        // without notes would silently keep the notes from the first one.
        withdrawalNotes: notes ?? null,
        // How much warning the shift got. The counterpart to the
        // insufficient_notice reason staff themselves select — this is the
        // same measure taken from the other side.
        withdrawalRequestedAt: new Date(),
      },
    });
  }

  /** Manager denies a withdrawal request — assignment reverts to accepted. */
  async denyWithdrawal(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "accepted",
        withdrawalReason: null,
        withdrawalNotes: null,
        // Cleared with the reason it belongs to. Leaving it set would report
        // a withdrawal that was refused as one that happened, and the member
        // is back on the shift.
        withdrawalRequestedAt: null,
      },
    });
  }

  /**
   * A staff member's own rating of a shift they worked.
   *
   * `comment ?? null` rather than `undefined` — re-rating without a comment
   * must clear the previous one, or the new score is shown next to reasoning
   * for the old one.
   */
  async rate(id: string, rating: number, comment?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        satisfactionRating: rating,
        satisfactionComment: comment ?? null,
        ratedAt: new Date(),
      },
    });
  }

  /**
   * Counts active (slot-occupying) assignments for a task.
   *
   * "Occupying" is `occupyingStatusFilter()` — everything except rejected and
   * withdrawn. That includes a decision still waiting on a manager, in either
   * direction: a pending withdrawal or a pending full-time decline keeps the
   * seat until it is resolved. Used against requiredHeadcount before adding
   * more.
   */
  async countActiveByTaskId(taskId: string): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        taskId,
        // The shared rule, which also covers clocked_out and completed. The
        // hand-written list here undercounted an in-progress shift, so a
        // manager could assign past requiredHeadcount once people clocked in.
        status: { in: occupyingStatusFilter() },
      },
    });
  }

  /** Cancels (deletes) an assignment — admin/manager action */
  async cancel(id: string) {
    return prisma.taskAssignment.delete({ where: { id } });
  }

  /**
   * An approved withdrawal: the slot is given back, the record is kept.
   *
   * This used to be `cancel`, which DELETES the row — and the deletion was the
   * quiet cause of three separate problems.
   *
   * `withdrawn` is in `ASSIGNMENT_STATUSES` and in `RELEASED_STATUSES`,
   * `shift-outcome` maps it to a "withdrawn" outcome, the history filter has a
   * `case "withdrawn"`, and reporting counts it among the shifts that fell
   * through. **Nothing in the application ever wrote it.** The only rows
   * carrying it came from `prisma/seed-demo.ts`, which is why the demo looked
   * right and a real organisation's My History showed nothing under that
   * filter.
   *
   * It also lost the record of an event the audit log describes but cannot
   * point at, and — the reason this became urgent — it made the member a
   * candidate for their own shift again the instant the request was approved:
   * `AllocationService.buildCandidatePool` excludes "anyone who already has a
   * row on this shift", so deleting the row deletes the exclusion. Nothing
   * records WHY somebody withdrew as a fact about their availability, so the
   * engine would have ranked them as an excellent fit and offered it straight
   * back.
   *
   * `withdrawalRequestedAt` is deliberately kept. Every reporting panel reads
   * that TIMESTAMP rather than the status, and it is the measure of how much
   * warning the shift got.
   *
   * The sibling flow already did it this way: `approveDecline` sets `rejected`
   * and keeps the row. The two are the same decision at different points in
   * the lifecycle and should not disagree about whether history survives it.
   */
  async withdraw(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "withdrawn" },
    });
  }

  /**
   * A member's finished shifts that started on or after `since`, for summing
   * hours actually worked. Rows without a clock-out are excluded: an open
   * shift has no measurable duration and would otherwise be counted as zero,
   * quietly understating how close the member is to their limit.
   */
  async findWorkedSince(membershipId: string, since: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: ["clocked_out", "completed"] },
        clockInTime: { gte: since },
        clockOutTime: { not: null },
      },
    });
  }

  /**
   * How often a member has actually served a given department. Feeds the AI
   * ranker's familiarity signal, so only assignments the member took count —
   * a pending offer they may still reject says nothing about experience.
   */
  async countDepartmentHistory(
    membershipId: string,
    departmentId: string
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        membershipId,
        task: { departmentId },
        status: { in: ["accepted", "clocked_out", "completed"] },
      },
    });
  }

  /**
   * A member's assignments in the given statuses, paired with their task's
   * scheduled window. The eligibility engine needs BOTH: hours already clocked
   * and hours merely committed to a future shift. Loading only clock times
   * would make an over-booked week look empty until the shifts were worked.
   *
   * `excludeTaskId` drops the task being evaluated so it is not counted
   * against itself when re-checking after a reschedule.
   */
  async findCommittedWithSchedule(
    membershipId: string,
    statuses: string[],
    excludeTaskId?: string
  ) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: statuses },
        ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}),
      },
      select: {
        // `taskId` so a caller can exclude the task under evaluation in memory
        // rather than in the query. That is what lets one member's commitments
        // be loaded ONCE for a whole run instead of once per task — see
        // `EligibilityService.loadStoredAssignments`.
        taskId: true,
        clockInTime: true,
        clockOutTime: true,
        task: { select: { scheduledStart: true, scheduledEnd: true } },
      },
    });
  }

  /**
   * A member's live assignments to shifts that have not started yet.
   *
   * "Live" means still standing — the shared occupying set, which includes a
   * decline or a withdrawal still awaiting a manager's decision. A rejected or
   * withdrawn assignment is not at risk because nobody is expecting that
   * person to turn up.
   *
   * Deliberately future-only. When someone changes their availability, alerting
   * a manager about a shift that has already been worked is noise about
   * something nobody can act on.
   */
  async findUpcomingCommitments(membershipId: string, from: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: occupyingStatusFilter() },
        task: { scheduledStart: { gte: from } },
      },
      select: {
        id: true,
        task: {
          select: {
            id: true,
            title: true,
            organizationId: true,
            departmentId: true,
            scheduledStart: true,
          },
        },
      },
      orderBy: { task: { scheduledStart: "asc" } },
    });
  }

  /**
   * Recent rejections across an organisation, with the rejecting member.
   * Scoped through the task's org because an assignment has no organizationId
   * of its own — joining on the member instead would let a person who moved
   * organisations drag their old rejections into the new tenant's analysis.
   */
  async findRecentRejections(organizationId: string, since: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        task: { organizationId },
        status: "rejected",
        createdAt: { gte: since },
      },
      include: {
        membership: {
          // `id` for grouping, `userId` because the dashboard's follow-up
          // action addresses a person rather than a membership — the member
          // routes are keyed on user id.
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
  }

  /**
   * Shifts finished across an organisation since a cut-off. Counts on
   * clock-OUT time, not the assignment's creation date: a shift created
   * yesterday and finished this morning belongs to today's tally.
   */
  async countCompletedSince(
    organizationId: string,
    since: Date
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        task: { organizationId },
        status: { in: ["clocked_out", "completed"] },
        clockOutTime: { gte: since },
      },
    });
  }

  /**
   * Clock times for a member's committed shifts whose task sits entirely
   * inside a window — the auto-scheduler's "hours already on this week"
   * figure. Only assignments that have been clocked into are considered, so
   * the number reflects work under way rather than intentions.
   */
  /**
   * Everything a member is COMMITTED to in a window, worked or not.
   *
   * Distinct from `findClockedWithinWindow` beside it, which requires a
   * clock-in and so answers "what have they actually done". That is the right
   * question for a timesheet and the wrong one for a scheduler: a shift booked
   * for next Tuesday has no clock-in, so it counted as zero load and the
   * fully-booked member read as the freshest person available — while the
   * ranker weights "fewest hours worked" at 30%.
   *
   * Returns both the clock times and the scheduled window so the caller can
   * prefer actuals where they exist and fall back to what was planned.
   */
  async findCommitmentsWithinWindow(
    membershipId: string,
    windowStart: Date,
    windowEnd: Date
  ) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: occupyingStatusFilter() },
        task: {
          scheduledStart: { gte: windowStart },
          scheduledEnd: { lte: windowEnd },
        },
      },
      select: {
        clockInTime: true,
        clockOutTime: true,
        task: { select: { scheduledStart: true, scheduledEnd: true } },
      },
    });
  }

  async findClockedWithinWindow(
    membershipId: string,
    windowStart: Date,
    windowEnd: Date
  ) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: ["accepted", "clocked_out", "completed"] },
        clockInTime: { not: null },
        task: {
          scheduledStart: { gte: windowStart },
          scheduledEnd: { lte: windowEnd },
        },
      },
      select: { clockInTime: true, clockOutTime: true },
    });
  }

  /**
   * Which rows count as a member's history. Shared by the list and the totals.
   *
   * ## "Over for this member", not "in the past"
   *
   * Three ways a shift leaves their plate, and they are not the same set:
   *
   *  - the shift ENDED. Whatever state the row is in — completed, or accepted
   *    and never clocked out because somebody forgot — it is not upcoming, and
   *    a history that hid the forgotten ones would hide exactly the rows worth
   *    looking at;
   *  - they GAVE THE SLOT BACK. `RELEASED_STATUSES` — rejected or withdrawn.
   *    That is a past event in their record even when the shift itself is next
   *    Tuesday, and it is no longer something they have to turn up for;
   *  - the shift was CANCELLED. The assignment keeps whatever status it had, so
   *    without this a cancelled future shift would fall in history's blind
   *    spot: gone from the upcoming list, absent from the record of what
   *    happened.
   *
   * A pending assignment on an unscheduled task satisfies none of the three and
   * stays out, which is right — nothing about it has happened yet.
   *
   * ## Why this is one function
   *
   * The list is paged and the totals are not, so they cannot share a query. If
   * they did not share the DEFINITION, "12 shifts, 47 hours" would eventually
   * describe a different set of rows than the twelve printed underneath it, and
   * nothing about either number would look wrong.
   */
  private historyWhere(
    membershipId: string,
    options: HistoryFilters,
    now: Date
  ) {
    /*
     * The range filters the SHIFT's date, so "last 30 days" means 30 days of
     * roster rather than 30 days of data entry. It nests under `AND` rather
     * than a second top-level `task` key, which would overwrite nothing here
     * today but would silently drop a `task` condition the moment one is added
     * outside the `OR`.
     */
    const range =
      options.from || options.to
        ? [
            {
              task: {
                scheduledStart: {
                  ...(options.from ? { gte: options.from } : {}),
                  ...(options.to ? { lte: options.to } : {}),
                },
              },
            },
          ]
        : [];

    /*
     * Department and free text are ordinary conditions; they go in the same
     * `AND` for the same reason the range does.
     *
     * `mode: "insensitive"` because the member typing here is looking for a
     * shift they remember, not running a query. Making them match the
     * capitalisation a manager used when creating it would be a search that
     * works only if you already know the answer.
     */
    const department = options.departmentId
      ? [{ task: { departmentId: options.departmentId } }]
      : [];

    const search = options.search?.trim()
      ? [
          {
            task: {
              title: { contains: options.search.trim(), mode: "insensitive" as const },
            },
          },
        ]
      : [];

    const outcome = options.outcome ? [outcomeWhere(options.outcome)] : [];

    return {
      membershipId,
      OR: [
        { task: { scheduledEnd: { lt: now } } },
        { status: { in: [...RELEASED_STATUSES] } },
        { task: { status: "cancelled" } },
      ],
      AND: [...range, ...department, ...search, ...outcome],
    };
  }

  /**
   * One page of a member's finished shifts, newest first.
   *
   * Ordered by the shift's own start rather than `createdAt`: a history is read
   * as a diary, and rows entered out of order — a manager backfilling last week
   * — would otherwise interleave with this week's. `createdAt` and `id` break
   * the tie so the order is total, without which paging can repeat or skip a
   * row.
   *
   * Unscheduled tasks sort last. Postgres puts NULLs first on DESC, which would
   * open every member's history with the rows that have no date on them.
   */
  async findHistoryForMember(
    membershipId: string,
    options: HistoryFilters & { take: number; skip: number },
    now: Date = new Date()
  ) {
    const where = this.historyWhere(membershipId, options, now);

    const [rows, total] = await Promise.all([
      prisma.taskAssignment.findMany({
        where,
        include: {
          task: {
            select: {
              id: true,
              title: true,
              status: true,
              priority: true,
              scheduledStart: true,
              scheduledEnd: true,
              // Colour travels with the name everywhere a task is read — the
              // department chip cannot be drawn without it.
              department: { select: { id: true, name: true, color: true } },
            },
          },
        },
        orderBy: [
          { task: { scheduledStart: { sort: "desc", nulls: "last" } } },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: options.take,
        skip: options.skip,
      }),
      prisma.taskAssignment.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * The departments this member has actually worked in, for the filter's list.
   *
   * Not from `GET /departments` — that endpoint is manager-only, and widening
   * it so a staff member can populate a dropdown would trade a permission
   * boundary for a convenience. This is the member's own history either way.
   *
   * Computed over the DATE RANGE only, deliberately ignoring the department,
   * outcome and search filters. A list that narrowed as you used it would
   * collapse to the one option you had chosen, leaving no way back to the
   * others without clearing the filter you could no longer see.
   */
  async historyDepartments(
    membershipId: string,
    options: { from?: Date; to?: Date },
    now: Date = new Date()
  ) {
    const rows = await prisma.taskAssignment.findMany({
      where: this.historyWhere(membershipId, options, now),
      select: {
        task: {
          select: { department: { select: { id: true, name: true, color: true } } },
        },
      },
      distinct: ["taskId"],
    });

    const seen = new Map<string, { id: string; name: string; color: string | null }>();
    for (const row of rows) {
      const d = row.task.department;
      if (d && !seen.has(d.id)) seen.set(d.id, d);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The same rows, reduced to the columns the totals need.
   *
   * Unpaged on purpose. Deriving the totals from the page would make "12
   * shifts, 47 hours" mean "12 shifts on this page" — a figure that changes
   * when you click next, which is the kind of number a reader trusts precisely
   * because they assume it cannot.
   */
  async summariseHistoryForMember(
    membershipId: string,
    options: HistoryFilters,
    now: Date = new Date()
  ) {
    return prisma.taskAssignment.findMany({
      where: this.historyWhere(membershipId, options, now),
      select: {
        status: true,
        clockInTime: true,
        clockOutTime: true,
        satisfactionRating: true,
        task: { select: { scheduledStart: true, scheduledEnd: true } },
      },
    });
  }
}
