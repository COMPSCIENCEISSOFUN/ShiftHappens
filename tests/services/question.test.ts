/**
 * Questions asked from the landing page.
 *
 * The case that matters is the one with no account behind it: this is the only
 * write in the application a stranger can reach, and an anonymous row is the
 * ordinary outcome rather than a degenerate one.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  QuestionService,
  QUESTION_MAX_LENGTH,
  QUESTION_PAGE_SIZE,
} from "@/services/question.service";

import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const questions = new QuestionService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("ask");
});

/** Writes directly, for the reads that do not care how a row got there. */
async function seed(body: string, extra: Record<string, unknown> = {}) {
  return prisma.question.create({ data: { body, ...extra } });
}

describe("asking", () => {
  it("stores a question with no account behind it", async () => {
    const created = await questions.ask({ body: "Is there a free trial?" });

    const row = await prisma.question.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.membershipId).toBeNull();
    expect(row.organizationId).toBeNull();
    expect(row.handledAt).toBeNull();
  });

  it("attributes one asked by a signed-in member", async () => {
    const created = await questions.ask(
      { body: "Can I see who has not responded?" },
      { userId: tenant.staff.userId, organizationId: tenant.orgId }
    );

    const row = await prisma.question.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.membershipId).toBe(tenant.staff.membershipId);
    expect(row.organizationId).toBe(tenant.orgId);
  });

  /*
   * An asker claiming an organisation they do not belong to is stored as
   * anonymous rather than refused. The question is still worth hearing, and the
   * list shows the organisation beside the words — so a wrong one is worse than
   * none.
   */
  it("drops the attribution when the asker is not a member of that organisation", async () => {
    const other = await createTenant("ask-other");

    const created = await questions.ask(
      { body: "Whose organisation is this?" },
      { userId: other.staff.userId, organizationId: tenant.orgId }
    );

    const row = await prisma.question.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.membershipId).toBeNull();
    expect(row.organizationId).toBeNull();
  });

  it("trims, and stores blank optional fields as null", async () => {
    const created = await questions.ask({
      body: "  Spaced out?  ",
      name: "   ",
      email: "   ",
    });

    const row = await prisma.question.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.body).toBe("Spaced out?");
    expect(row.name).toBeNull();
    expect(row.email).toBeNull();
  });

  it("refuses a question that is only whitespace", async () => {
    await expect(questions.ask({ body: "  \n  " })).rejects.toThrow(
      /please write your question/i
    );
    expect(await prisma.question.count()).toBe(0);
  });

  it("refuses a question past the cap", async () => {
    await expect(
      questions.ask({ body: "x".repeat(QUESTION_MAX_LENGTH + 1) })
    ).rejects.toThrow(/characters or fewer/i);
  });

  it("refuses something that is not an email address", async () => {
    await expect(
      questions.ask({ body: "Fine?", email: "not-an-address" })
    ).rejects.toThrow(/does not look like an email/i);
  });

  /* Loose on purpose — the address is only ever shown to the admin. */
  it("accepts an unusual but plausible address", async () => {
    const created = await questions.ask({
      body: "Fine?",
      email: "first+tag@sub.domain.example",
    });

    expect(created.email).toBe("first+tag@sub.domain.example");
  });
});

describe("the platform list", () => {
  it("returns the oldest first, because it is a queue of work", async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await seed("Newer");
    await seed("Older", { createdAt: old });

    const { rows } = await questions.getList();

    expect(rows.map((row) => row.body)).toEqual(["Older", "Newer"]);
  });

  it("hides handled questions unless asked for them", async () => {
    await seed("Waiting");
    await seed("Done", { handledAt: new Date() });

    const waiting = await questions.getList();
    expect(waiting.total).toBe(1);
    expect(waiting.rows[0].body).toBe("Waiting");

    const all = await questions.getList(true);
    expect(all.total).toBe(2);
  });

  it("counts handled questions in the recent total either way", async () => {
    await seed("Waiting");
    await seed("Done", { handledAt: new Date() });

    const { askedRecently } = await questions.getList();

    expect(askedRecently).toBe(2);
  });

  it("clamps a page past the end and reports the one it served", async () => {
    await seed("The only one");

    const result = await questions.getList(false, 40);

    expect(result.page).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  it("pages without repeating or skipping a row", async () => {
    const overflow = QUESTION_PAGE_SIZE + 2;
    for (let i = 0; i < overflow; i++) {
      await seed(`Question ${i}`);
    }

    const first = await questions.getList(false, 0);
    const second = await questions.getList(false, 1);

    expect(first.rows).toHaveLength(QUESTION_PAGE_SIZE);
    expect(second.rows).toHaveLength(2);
    expect(first.total).toBe(overflow);

    const ids = new Set([...first.rows, ...second.rows].map((row) => row.id));
    expect(ids.size).toBe(overflow);
  });

  it("returns an empty page rather than failing when nothing has been asked", async () => {
    const { rows, total } = await questions.getList();

    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});

describe("marking handled", () => {
  it("clears it from the list and puts it back", async () => {
    const row = await seed("Deal with me");

    const handled = await questions.setHandled(row.id, true);
    expect(handled.handledAt).not.toBeNull();
    expect((await questions.getList()).total).toBe(0);

    const restored = await questions.setHandled(row.id, false);
    expect(restored.handledAt).toBeNull();
    expect((await questions.getList()).total).toBe(1);
  });

  it("refuses an id that does not exist", async () => {
    await expect(questions.setHandled("no-such-id", true)).rejects.toThrow(
      /not found/i
    );
  });

  /*
   * The asker's account going away must not take the question with it: the
   * foreign keys are SET NULL, not CASCADE, because a question outlives the
   * organisation that asked it and the FAQ entry it justified stays true.
   */
  it("survives the asker's organisation being deleted", async () => {
    await questions.ask(
      { body: "Still worth answering" },
      { userId: tenant.staff.userId, organizationId: tenant.orgId }
    );

    await prisma.organization.delete({ where: { id: tenant.orgId } });

    const { rows, total } = await questions.getList();
    expect(total).toBe(1);
    expect(rows[0].body).toBe("Still worth answering");
    expect(rows[0].organization).toBeNull();
  });
});
