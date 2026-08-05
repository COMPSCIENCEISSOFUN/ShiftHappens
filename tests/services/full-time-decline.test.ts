/**
 * A full-time member declining a rostered shift.
 *
 * A casual turning down an offer and a full-timer refusing a rostered shift are
 * different acts, and until now the system could not tell them apart — anyone
 * could empty a slot instantly. Blocking full-time declines outright was the
 * alternative and it is worse: people still get ill, so the decline happens by
 * phone and the reason, timestamp and audit entry are all lost.
 *
 * So a full-time decline becomes a request. Most of what follows pins the two
 * things that make it a request rather than a slower rejection: the slot stays
 * filled while it is pending, and refusing it returns the row to PENDING rather
 * than accepting the shift on the member's behalf.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new TaskAssignmentService();
const repo = new TaskAssignmentRepository();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("ftdecline");
});

async function shift(headcount = 3) {
  const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
  return prisma.task.create({
    data: {
      title: "Lunch Service",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: headcount,
      status: "open",
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 4 * 60 * 60 * 1000),
    },
  });
}

async function offer(taskId: string, membershipId: string) {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: tenant.admin.userId,
      status: "pending",
    },
  });
}

async function setEmployment(membershipId: string, employmentType: string | null) {
  await prisma.membership.update({
    where: { id: membershipId },
    data: { employmentType },
  });
}

describe("casual staff are unchanged", () => {
  /**
   * They are under no obligation to take an offered shift. Making them ask
   * permission to decline one would assert a contractual relationship that does
   * not exist.
   */
  it("declines immediately, freeing the slot", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "casual");

    const result = await service.reject(
      a.id,
      tenant.staff.membershipId,
      "schedule_conflict"
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectedAt).not.toBeNull();
    expect(await repo.countActiveByTaskId(task.id)).toBe(0);
  });

  // NULL means the field was never set, which the whole codebase reads as
  // casual. A member whose record predates the field must not silently acquire
  // an obligation nobody recorded them agreeing to.
  it("treats an unset employment type as casual", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, null);

    const result = await service.reject(
      a.id,
      tenant.staff.membershipId,
      "feeling_unwell"
    );

    expect(result.status).toBe("rejected");
  });
});

describe("full-time staff", () => {
  it("produces a request rather than a rejection", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");

    const result = await service.reject(
      a.id,
      tenant.staff.membershipId,
      "feeling_unwell",
      "Came down with something overnight"
    );

    expect(result.status).toBe("decline_requested");
    // The member's own words, stored where an approval will need them.
    expect(result.rejectionReason).toBe("feeling_unwell");
    expect(result.rejectionNotes).toBe("Came down with something overnight");
  });

  /**
   * The point of the whole design. If the slot emptied on request, a manager
   * could assign a replacement into a seat whose original occupant is still
   * expected to turn up — and might be, if the request is refused.
   */
  it("keeps the slot filled while the request is pending", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");

    await service.reject(a.id, tenant.staff.membershipId, "transport_issues");

    expect(await repo.countActiveByTaskId(task.id)).toBe(1);
  });

  it("does not stamp rejectedAt until a manager agrees", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");

    const requested = await service.reject(
      a.id,
      tenant.staff.membershipId,
      "personal_reasons"
    );
    expect(requested.rejectedAt).toBeNull();

    const approved = await service.resolveDecline(
      a.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );
    expect(approved.rejectedAt).not.toBeNull();
  });

  it("clears notes from a previous request rather than keeping them", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");

    await service.reject(a.id, tenant.staff.membershipId, "feeling_unwell", "Flu");
    await service.resolveDecline(a.id, "deny", tenant.admin.userId, tenant.orgId);
    const second = await service.reject(
      a.id,
      tenant.staff.membershipId,
      "transport_issues"
    );

    expect(second.rejectionNotes).toBeNull();
  });

  /**
   * Tested at the repository, because through the service it is currently
   * unreachable: the only route back to pending is `denyDecline`, which already
   * clears the notes. Mutation testing showed that — removing `?? null` from
   * `requestDecline` broke nothing.
   *
   * It stays, and it is tested here, because Prisma IGNORES undefined: the day
   * anything else returns a row to pending with notes still on it, a second
   * request without notes would silently inherit the first one's, and a manager
   * would read words the member did not write this time.
   */
  it("writes null, not undefined, when a request carries no notes", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await prisma.taskAssignment.update({
      where: { id: a.id },
      data: { rejectionNotes: "Left over from an earlier request" },
    });

    const result = await repo.requestDecline(a.id, "transport_issues");

    expect(result.rejectionNotes).toBeNull();
  });

  it("still refuses to decline anything that is not pending", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");
    await repo.accept(a.id);

    await expect(
      service.reject(a.id, tenant.staff.membershipId, "feeling_unwell")
    ).rejects.toThrow("Can only reject pending assignments");
  });

  it("still refuses a decline from someone else's membership", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");

    await expect(
      service.reject(a.id, tenant.manager.membershipId, "feeling_unwell")
    ).rejects.toThrow("Not authorized");
  });
});

describe("the manager's decision", () => {
  async function pendingDecline() {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");
    await service.reject(
      a.id,
      tenant.staff.membershipId,
      "feeling_unwell",
      "Not well enough to be near food"
    );
    return { task, assignmentId: a.id };
  }

  it("approving frees the slot and keeps the member's reason", async () => {
    const { task, assignmentId } = await pendingDecline();

    const result = await service.resolveDecline(
      assignmentId,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(result.status).toBe("rejected");
    // Not overwritten by the manager — these are the member's words.
    expect(result.rejectionReason).toBe("feeling_unwell");
    expect(result.rejectionNotes).toBe("Not well enough to be near food");
    expect(await repo.countActiveByTaskId(task.id)).toBe(0);
  });

  /**
   * The reason this flow does not reuse `withdrawal_requested`: denying a
   * withdrawal returns the row to "accepted", and doing that here would record
   * an acceptance the member never gave.
   */
  it("denying returns the shift to pending, not to accepted", async () => {
    const { assignmentId } = await pendingDecline();

    const result = await service.resolveDecline(
      assignmentId,
      "deny",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(result.status).toBe("pending");
    expect(result.acceptedAt).toBeNull();
  });

  // A refused request should not leave the row looking like it carries a live
  // decline, or a later genuine one would read as a repeat.
  it("denying clears the reason it refused", async () => {
    const { assignmentId } = await pendingDecline();

    const result = await service.resolveDecline(
      assignmentId,
      "deny",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(result.rejectionReason).toBeNull();
    expect(result.rejectionNotes).toBeNull();
  });

  it("lets the member answer again after a denial", async () => {
    const { assignmentId } = await pendingDecline();
    await service.resolveDecline(
      assignmentId,
      "deny",
      tenant.admin.userId,
      tenant.orgId
    );

    const accepted = await service.accept(assignmentId, tenant.staff.membershipId);
    expect(accepted.status).toBe("accepted");
  });

  it("refuses to resolve an assignment with no pending request", async () => {
    const task = await shift();
    const a = await offer(task.id, tenant.staff.membershipId);

    await expect(
      service.resolveDecline(a.id, "approve", tenant.admin.userId, tenant.orgId)
    ).rejects.toThrow("No pending decline request");
  });

  // Cross-tenant guard: a manager elsewhere must not be able to resolve this by
  // guessing an id.
  it("refuses to resolve an assignment in another organisation", async () => {
    const { assignmentId } = await pendingDecline();
    const other = await createTenant("ftdecline-other");

    await expect(
      service.resolveDecline(assignmentId, "approve", other.admin.userId, other.orgId)
    ).rejects.toThrow("Assignment not found");
  });
});

describe("what a manager sees on the shift", () => {
  /**
   * The screenshot that started this: a shift both assignees had rejected
   * displayed "2/3 staff". A pending decline must still read as filled, and an
   * approved one must not.
   */
  it("reports the shift as filled until the decline is approved", async () => {
    const task = await shift(2);
    const a = await offer(task.id, tenant.staff.membershipId);
    const b = await offer(task.id, tenant.manager.membershipId);
    await setEmployment(tenant.staff.membershipId, "full_time");
    await setEmployment(tenant.manager.membershipId, "casual");

    expect(await repo.countActiveByTaskId(task.id)).toBe(2);

    await service.reject(a.id, tenant.staff.membershipId, "feeling_unwell");
    expect(await repo.countActiveByTaskId(task.id)).toBe(2);

    await service.resolveDecline(a.id, "approve", tenant.admin.userId, tenant.orgId);
    expect(await repo.countActiveByTaskId(task.id)).toBe(1);

    await service.reject(b.id, tenant.manager.membershipId, "schedule_conflict");
    expect(await repo.countActiveByTaskId(task.id)).toBe(0);
  });
});

/**
 * The regression that adding `decline_requested` created, and the reason the
 * shared rule now covers more than headcount.
 *
 * Six status lists predated the new state and kept their own copies on the
 * grounds that they were future-facing and therefore equivalent to the shared
 * set. That was true of the statuses existing at the time and stopped being
 * true the moment a new one appeared.
 */
describe("a pending decline still ties up the member's time", () => {
  async function overlappingShift(title: string) {
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
    return prisma.task.create({
      data: {
        title,
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        requiredHeadcount: 1,
        status: "open",
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      },
    });
  }

  /**
   * The member is still rostered until a manager decides. If the conflict
   * finder stops seeing the shift, they can be booked onto an overlapping one —
   * and if the decline is then refused, they are double-booked on two shifts
   * they are expected to work.
   */
  it("is still found as a scheduling conflict", async () => {
    const { TaskRepository } = await import("@/repositories/task.repository");
    const taskRepo = new TaskRepository();

    const first = await overlappingShift("First");
    const second = await overlappingShift("Second");
    const a = await prisma.taskAssignment.create({
      data: {
        taskId: first.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "pending",
      },
    });
    await setEmployment(tenant.staff.membershipId, "full_time");
    await service.reject(a.id, tenant.staff.membershipId, "feeling_unwell");

    const conflicts = await taskRepo.findConflictingTasks(
      tenant.staff.membershipId,
      second.scheduledStart!,
      second.scheduledEnd!,
      second.id
    );

    expect(conflicts.map((t) => t.id)).toContain(first.id);
  });

  // An approved decline genuinely frees the time, so the conflict must clear.
  it("stops being a conflict once the decline is approved", async () => {
    const { TaskRepository } = await import("@/repositories/task.repository");
    const taskRepo = new TaskRepository();

    const first = await overlappingShift("First");
    const second = await overlappingShift("Second");
    const a = await prisma.taskAssignment.create({
      data: {
        taskId: first.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "pending",
      },
    });
    await setEmployment(tenant.staff.membershipId, "full_time");
    await service.reject(a.id, tenant.staff.membershipId, "feeling_unwell");
    await service.resolveDecline(a.id, "approve", tenant.admin.userId, tenant.orgId);

    const conflicts = await taskRepo.findConflictingTasks(
      tenant.staff.membershipId,
      second.scheduledStart!,
      second.scheduledEnd!,
      second.id
    );

    expect(conflicts.map((t) => t.id)).not.toContain(first.id);
  });
});
