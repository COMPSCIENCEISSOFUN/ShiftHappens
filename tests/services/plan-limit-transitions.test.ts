// @vitest-environment node
/**
 * Plan limits, on the transitions rather than the creates.
 *
 * Every limit counts a STATE: active memberships, non-archived departments,
 * tasks that are neither completed nor cancelled. Every limit was enforced on
 * the CREATE path and only there, so any transition that moved a row back INTO
 * the counted state walked straight past the cap. Four of them did.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UserManagementService } from "@/services/user-management.service";
import { InvitationService } from "@/services/invitation.service";
import { DepartmentService } from "@/services/department.service";
import { TaskService } from "@/services/task.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { getResourceLimit } from "@/lib/subscription-tiers";

const users = new UserManagementService();
const invitations = new InvitationService();
const departments = new DepartmentService();
const tasks = new TaskService();

/** Free plan: members 10, departments 2, active_tasks 20. */
let tenant: Tenant;
let filler = 0;

function activeMembers() {
  return prisma.membership.count({
    where: { organizationId: tenant.orgId, status: "active" },
  });
}

function liveDepartments() {
  return prisma.department.count({
    where: { organizationId: tenant.orgId, archivedAt: null },
  });
}

function activeTasks() {
  return prisma.task.count({
    where: {
      organizationId: tenant.orgId,
      status: { notIn: ["completed", "cancelled"] },
    },
  });
}

/** Adds active members until the org has exactly `target`. */
async function fillMembersTo(target: number) {
  while ((await activeMembers()) < target) {
    const user = await prisma.user.create({
      data: {
        name: "Filler",
        email: `filler-${tenant.orgSlug}-${filler++}@example.com`,
        hashedPassword: "hash",
      },
    });
    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: tenant.orgId,
        role: "staff",
        status: "active",
      },
    });
  }
}

beforeEach(async () => {
  await cleanDatabase();
  filler = 0;
  tenant = await createTenant("tier", { subscriptionTier: "free" });
});

describe("an invitation does not reserve a seat, so accepting has to check", () => {
  it("refuses the acceptance that would take the org over its limit", async () => {
    await fillMembersTo(9);

    /*
     * Two invitations, both allowed — and that is correct, not a bug. An
     * invitation is not a membership, so at 9 of 10 the second one is still
     * within the limit at the moment it is SENT. The cap has to be re-checked
     * when the seat is actually taken, which is the whole point.
     */
    const tokens: string[] = [];
    for (const email of ["a@example.com", "b@example.com"]) {
      await users.inviteUser(
        { email, role: "staff" },
        tenant.orgId,
        tenant.admin.userId
      );
      const invite = await prisma.invitationToken.findFirstOrThrow({
        where: { organizationId: tenant.orgId, email },
      });
      tokens.push(invite.token);
    }

    // The first taker gets the last seat.
    await invitations.acceptInvitation(tokens[0], {
      name: "First",
      password: "TestPass1!",
    });
    expect(await activeMembers()).toBe(10);

    // The second is refused.
    await expect(
      invitations.acceptInvitation(tokens[1], {
        name: "Second",
        password: "TestPass1!",
      })
    ).rejects.toThrow(/limit reached/);

    expect(await activeMembers()).toBe(10);

    /*
     * And the invitation survives the refusal.
     *
     * This is the organisation's problem rather than the invitee's, so the link
     * has to still work once somebody frees a place. Marking it accepted on the
     * way out would have burned it on an org that was full for ten seconds.
     */
    const unused = await prisma.invitationToken.findFirstOrThrow({
      where: { organizationId: tenant.orgId, email: "b@example.com" },
    });
    expect(unused.acceptedAt).toBeNull();
  });
});

describe("reactivating a member takes a seat", () => {
  it("refuses when the plan is already full", async () => {
    await fillMembersTo(10);

    // Deactivating is the honest route back under a cap and stays unconditional.
    await users.toggleMemberStatus(
      tenant.staff.userId,
      tenant.orgId,
      tenant.admin.userId
    );
    expect(await activeMembers()).toBe(9);

    // Somebody legitimately takes the freed seat.
    await fillMembersTo(10);

    await expect(
      users.toggleMemberStatus(
        tenant.staff.userId,
        tenant.orgId,
        tenant.admin.userId
      )
    ).rejects.toThrow(/limit reached/);

    expect(await activeMembers()).toBe(10);
  });

  it("still lets anybody be deactivated when the org is over its limit", async () => {
    /*
     * The other direction, and it matters more than it looks. An organisation
     * can be over its cap for reasons no guard can prevent — a downgrade, or
     * seats taken before these checks existed. If the limit were enforced on
     * every status change rather than only on the way IN, such an org could
     * never get back under it: the one action that reduces the count would be
     * refused because the count is too high.
     */
    await fillMembersTo(12);

    await expect(
      users.toggleMemberStatus(
        tenant.staff.userId,
        tenant.orgId,
        tenant.admin.userId
      )
    ).resolves.toBeDefined();

    expect(await activeMembers()).toBe(11);
  });
});

describe("unarchiving a department takes a slot", () => {
  it("refuses when the plan is already full", async () => {
    const second = await departments.create(
      { name: "Bar" },
      tenant.orgId,
      tenant.admin.userId
    );
    await departments.archive(second.id, tenant.orgId, tenant.admin.userId);

    /*
     * The freed slot goes to new departments, until the plan is full again.
     *
     * Filled in a loop against the configured cap rather than by creating one
     * named department: this test is about a slot being taken, not about Free
     * allowing exactly two, and it broke when the cap moved to three for a
     * reason that had nothing to do with unarchiving.
     */
    const cap = getResourceLimit("free", "departments") as number;
    while ((await liveDepartments()) < cap) {
      await departments.create(
        { name: `Filler ${await liveDepartments()}` },
        tenant.orgId,
        tenant.admin.userId
      );
    }
    expect(await liveDepartments()).toBe(cap);

    await expect(
      departments.unarchive(second.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/limit reached/);

    expect(await liveDepartments()).toBe(cap);
  });
});

describe("reopening a task takes a slot", () => {
  it("refuses when the plan is already full", async () => {
    const made = [];
    for (let i = 0; i < 20; i++) {
      made.push(
        await prisma.task.create({
          data: {
            title: `Shift ${i}`,
            organizationId: tenant.orgId,
            departmentId: tenant.departmentId,
            createdById: tenant.admin.userId,
            status: "open",
            priority: "medium",
            requiredHeadcount: 1,
          },
        })
      );
    }

    await prisma.task.update({
      where: { id: made[0].id },
      data: { status: "completed" },
    });
    await tasks.create(
      { title: "Replacement shift", departmentId: tenant.departmentId },
      tenant.orgId,
      tenant.admin.userId
    );
    expect(await activeTasks()).toBe(20);

    await expect(
      tasks.update(made[0].id, tenant.orgId, { status: "open" })
    ).rejects.toThrow(/limit reached/);

    expect(await activeTasks()).toBe(20);
  });

  /**
   * A task already inside the counted set must not be charged again.
   *
   * The check compares the two SETS rather than named statuses, so an ordinary
   * edit at the cap — moving a shift from open to in_progress, or renaming it —
   * goes through. Getting this wrong would make an organisation at its limit
   * unable to touch any of its own tasks, which is a far more visible bug than
   * the one being fixed.
   */
  it("does not charge an edit to a task that was already counted", async () => {
    for (let i = 0; i < 20; i++) {
      await prisma.task.create({
        data: {
          title: `Shift ${i}`,
          organizationId: tenant.orgId,
          departmentId: tenant.departmentId,
          createdById: tenant.admin.userId,
          status: "open",
          priority: "medium",
          requiredHeadcount: 1,
        },
      });
    }
    const one = await prisma.task.findFirstOrThrow({
      where: { organizationId: tenant.orgId },
    });

    await expect(
      tasks.update(one.id, tenant.orgId, { status: "in_progress" })
    ).resolves.toBeDefined();

    await expect(
      tasks.update(one.id, tenant.orgId, { title: "Renamed at the cap" })
    ).resolves.toBeDefined();
  });
});

/*
 * Kept rather than deleted. Each asserts the rule in both directions, and every
 * one of them goes red against the code as it was — the refusals did not exist
 * at all. Four freshly closed holes, on paths that went unguarded for months
 * precisely because nobody was looking, are not holes to leave unwatched.
 */
