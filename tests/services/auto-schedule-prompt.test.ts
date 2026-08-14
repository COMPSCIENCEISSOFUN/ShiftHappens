/**
 * What the model is told, and what it is judged on, must be the same list.
 *
 * ## The bug
 *
 * Composition rules were added to the gate on both draft paths without being
 * added to the prompt. The HARD RULES section listed five constraints and
 * composition was an unstated sixth: the model proposed blind, the gate
 * discarded what broke a rule, the AI draft filled fewer slots, and
 * `generateSchedule` then preferred the algorithmic pass on the "whichever
 * filled more" comparison. So on any organisation using composition rules the
 * AI path was quietly handicapped by a rule it had never been shown.
 *
 * The same reasoning applies to the attributes. A rule about seniority is
 * unusable by a model that is not told anyone's seniority — stating the rule
 * without the facts would be the same bug one layer down.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import {
  serialiseCompositionRules,
  type CompositionRule,
} from "@/lib/composition-rules";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { atHourSgt, nextMondaySgt } from "../helpers/time";

const service = new AutoScheduleService();

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

const AT_LEAST_ONE_FULL_TIME: CompositionRule = {
  kind: "employment_type",
  value: "full_time",
  comparator: "at_least",
  count: 1,
};

const AT_LEAST_ONE_FIRST_AID: CompositionRule = {
  kind: "certification",
  value: "First Aid",
  comparator: "at_least",
  count: 1,
};

let orgId: string;
let adminUserId: string;
let kitchenId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await prisma.user.create({
    data: { name: "Admin", email: "admin@prompt.test", hashedPassword: "h" },
  });
  adminUserId = admin.id;

  const org = await prisma.organization.create({
    data: { name: "Prompt Org", slug: "prompt-org" },
  });
  orgId = org.id;

  // Enterprise, for the reason given in auto-schedule.service.test: the column
  // defaults to "free", and Free excludes the engine these tests drive.
  await prisma.organization.update({
    where: { id: orgId },
    data: { subscriptionTier: "enterprise" },
  });

  await prisma.membership.create({
    data: { userId: admin.id, organizationId: orgId, role: "company_admin", status: "active" },
  });
  await prisma.companySettings.create({ data: { organizationId: orgId } });

  const kitchen = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  kitchenId = kitchen.id;
});

async function addStaff(
  label: string,
  departmentIds: string[],
  employmentType = "casual"
) {
  const user = await prisma.user.create({
    data: { name: label, email: `${label}@prompt.test`, hashedPassword: "h" },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
      employmentType,
    },
  });
  for (const d of departmentIds) {
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: d },
    });
  }
  for (let d = 1; d <= 5; d++) {
    await prisma.availability.create({
      data: {
        membershipId: membership.id,
        dayOfWeek: d,
        startTime: "06:00",
        endTime: "18:00",
        isAvailable: true,
      },
    });
  }
  return membership.id;
}

/** Completed shifts are the evidence seniority is derived from. */
async function giveWorkedShifts(
  membershipId: string,
  count: number,
  departmentId: string | null
) {
  for (let i = 0; i < count; i++) {
    const task = await prisma.task.create({
      data: {
        title: `Worked ${i}`,
        organizationId: orgId,
        departmentId,
        createdById: adminUserId,
        status: "completed",
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId,
        assignedById: adminUserId,
        status: "completed",
      },
    });
  }
}

async function makeTask(
  rules: CompositionRule[] | null,
  departmentId: string | null = kitchenId,
  title = "Evening shift",
  /**
   * Distinct hours matter whenever two tasks are created in one test: the
   * eligibility engine refuses to put anyone on two overlapping shifts, so
   * same-time fixtures measure double-booking rather than the rule under test.
   */
  startHour = 8
) {
  const weekStart = nextMondaySgt();
  const day = new Date(weekStart);
  day.setDate(day.getDate() + 1);

  return prisma.task.create({
    data: {
      title,
      organizationId: orgId,
      departmentId,
      priority: "high",
      status: "open",
      requiredHeadcount: 2,
      scheduledStart: atHourSgt(day, startHour),
      scheduledEnd: atHourSgt(day, startHour + 3),
      createdById: adminUserId,
      compositionRules: rules ? serialiseCompositionRules(rules) : null,
    },
  });
}

const prompt = () => service.previewPrompt(orgId, nextMondaySgt());

describe("the rules the model is given", () => {
  it("states a composition rule on the task it belongs to", async () => {
    await addStaff("alex", [kitchenId]);
    await makeTask([AT_MOST_ONE_JUNIOR]);

    expect(await prompt()).toContain(
      "COMPOSITION: At most 1 assignee at Junior or below"
    );
  });

  it("names composition among the hard rules, not the preferences", async () => {
    await addStaff("alex", [kitchenId]);
    await makeTask([AT_MOST_ONE_JUNIOR]);

    const text = await prompt();
    const hard = text.indexOf("HARD RULES");
    const preferences = text.indexOf("PREFERENCES");
    const composition = text.indexOf("6. Composition.");

    expect(composition).toBeGreaterThan(hard);
    expect(composition).toBeLessThan(preferences);
  });

  it("says nothing about composition when no task has rules", async () => {
    await addStaff("alex", [kitchenId]);
    await makeTask(null);

    expect(await prompt()).not.toContain("COMPOSITION");
  });

  it("uses the same wording the manager sees", async () => {
    await addStaff("alex", [kitchenId]);
    await makeTask([AT_LEAST_ONE_FIRST_AID]);

    // describeRule is what the assign screen and the refusal message use. The
    // model being told the constraint in different words from the person who
    // wrote it is how the two drift apart.
    expect(await prompt()).toContain("At least 1 assignee holding First Aid");
  });
});

describe("the facts a rule needs to be usable", () => {
  it("gives each member's seniority when a seniority rule exists", async () => {
    const alex = await addStaff("alex", [kitchenId]);
    await giveWorkedShifts(alex, 50, kitchenId);
    await makeTask([AT_MOST_ONE_JUNIOR]);

    expect(await prompt()).toContain("seniority: Kitchen=senior");
  });

  /*
   * Per department, because that is how the rule reads it: 50 kitchen shifts
   * make a senior kitchen hand and a junior behind the bar. One number would be
   * wrong for every task outside whichever department it came from — and the
   * gate would then discard proposals the model had every reason to believe
   * were legal.
   */
  it("scopes seniority per department", async () => {
    const bar = await prisma.department.create({
      data: { name: "Bar", organizationId: orgId, color: "#3B82F6" },
    });
    const alex = await addStaff("alex", [kitchenId, bar.id]);
    await giveWorkedShifts(alex, 50, kitchenId);

    await makeTask([AT_MOST_ONE_JUNIOR], kitchenId, "Kitchen shift", 8);
    await makeTask([AT_MOST_ONE_JUNIOR], bar.id, "Bar shift", 13);

    const text = await prompt();
    expect(text).toContain("Kitchen=senior");
    expect(text).toContain("Bar=junior");
  });

  /*
   * Only the departments the member is actually in.
   *
   * Everyone has a derivable level everywhere — nought shifts behind the bar is
   * "junior" — so without this filter a kitchen hand is listed with a bar level
   * too. That is noise on a prompt that already grows with headcount, and worse,
   * it implies they are a candidate for bar shifts when hard rule 1 forbids it.
   */
  it("does not quote a level for a department the member is not in", async () => {
    const bar = await prisma.department.create({
      data: { name: "Bar", organizationId: orgId, color: "#3B82F6" },
    });
    await addStaff("kitchen-only", [kitchenId]);

    await makeTask([AT_MOST_ONE_JUNIOR], kitchenId, "Kitchen shift", 8);
    await makeTask([AT_MOST_ONE_JUNIOR], bar.id, "Bar shift", 13);

    const text = await prompt();
    expect(text).toContain("Kitchen=junior");
    expect(text).not.toContain("Bar=");
  });

  it("quotes the org-wide figure for a task with no department", async () => {
    const alex = await addStaff("alex", [kitchenId]);
    await giveWorkedShifts(alex, 50, kitchenId);
    await makeTask([AT_MOST_ONE_JUNIOR], null, "Org-wide shift");

    // Not a fallback — org-wide counts every completed shift, so it is a
    // different number, and it is the one the rule would use here.
    expect(await prompt()).toContain("org-wide=senior");
  });

  it("gives employment type when an employment rule exists", async () => {
    await addStaff("alex", [kitchenId], "full_time");
    await makeTask([AT_LEAST_ONE_FULL_TIME]);

    expect(await prompt()).toContain("employment: full_time");
  });

  /*
   * A prompt that grows with headcount should not also grow with facts nothing
   * refers to. Certificates are listed for everyone already, so a certification
   * rule needs no extra attribute — and neither seniority nor employment type
   * belongs in a week whose rules never mention them.
   */
  it("leaves out attributes no rule this week reads", async () => {
    await addStaff("alex", [kitchenId], "full_time");
    await makeTask([AT_LEAST_ONE_FIRST_AID]);

    const text = await prompt();
    expect(text).toContain("COMPOSITION");
    expect(text).not.toContain("seniority:");
    expect(text).not.toContain("employment:");
  });

  it("leaves them out entirely when no task has rules", async () => {
    await addStaff("alex", [kitchenId], "full_time");
    await makeTask(null);

    const text = await prompt();
    expect(text).not.toContain("seniority:");
    expect(text).not.toContain("employment:");
  });
});

describe("the gate reads the same department scope the prompt quotes", () => {
  /*
   * The candidate index is built once per DEPARTMENT rather than once per task
   * — 1663ms down to 41ms on a hundred constrained tasks. The risk in that
   * change is losing the department scoping, which would make a bar novice
   * count as a kitchen veteran. This is the test that would catch it.
   */
  it("treats one member as senior in one department and junior in another", async () => {
    const bar = await prisma.department.create({
      data: { name: "Bar", organizationId: orgId, color: "#3B82F6" },
    });
    const veteran = await addStaff("veteran", [kitchenId, bar.id]);
    await giveWorkedShifts(veteran, 50, kitchenId);
    const junior = await addStaff("junior", [kitchenId, bar.id]);

    const kitchenTask = await makeTask([AT_MOST_ONE_JUNIOR], kitchenId, "Kitchen shift", 8);
    const barTask = await makeTask([AT_MOST_ONE_JUNIOR], bar.id, "Bar shift", 13);

    const draft = await service.generateSchedule(orgId, nextMondaySgt());

    // Kitchen: the veteran is senior there, so both can be rostered.
    expect(draft.assignments.filter((a) => a.taskId === kitchenTask.id)).toHaveLength(2);
    // Bar: both are junior there, so the rule allows only one.
    expect(draft.assignments.filter((a) => a.taskId === barTask.id)).toHaveLength(1);
    expect(junior).toBeTruthy();
  });
});
