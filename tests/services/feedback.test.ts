/**
 * Product feedback.
 *
 * Two things here are unlike anything else in the suite, and both are asserted
 * rather than assumed: the queue reads ACROSS tenants on purpose, and the
 * submitter's organisation is resolved from their membership rather than taken
 * from the request.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import { FeedbackService, FEEDBACK_PAGE_SIZE } from "@/services/feedback.service";
import { FEEDBACK_MAX_LENGTH } from "@/lib/feedback-areas";

import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const feedback = new FeedbackService();

let acme: Tenant;
let other: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  acme = await createTenant("fb-acme");
  other = await createTenant("fb-other");
});

/** Writes a row directly, for the reads that do not care how it got there. */
async function seed(
  tenant: Tenant,
  area: string,
  message: string,
  extra: { archivedAt?: Date; createdAt?: Date } = {}
) {
  return prisma.feedback.create({
    data: {
      organizationId: tenant.orgId,
      membershipId: tenant.staff.membershipId,
      area,
      message,
      ...extra,
    },
  });
}

describe("sending feedback", () => {
  it("stores it against the sender's own membership", async () => {
    const created = await feedback.submit(acme.staff.userId, acme.orgId, {
      area: "scheduling",
      message: "The week view is hard to read on a phone",
    });

    const row = await prisma.feedback.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.organizationId).toBe(acme.orgId);
    expect(row.membershipId).toBe(acme.staff.membershipId);
  });

  /*
   * The organisation comes from the membership, not from the caller.
   *
   * The queue prints the organisation next to the words, so a member of one
   * tenant filing against another would attribute a complaint to a customer who
   * never made it.
   */
  it("refuses a sender who does not belong to that organisation", async () => {
    await expect(
      feedback.submit(other.staff.userId, acme.orgId, {
        area: "billing",
        message: "Not my organisation",
      })
    ).rejects.toThrow(/not a member/i);

    expect(await prisma.feedback.count()).toBe(0);
  });

  it("refuses an area that is not on the list", async () => {
    await expect(
      feedback.submit(acme.staff.userId, acme.orgId, {
        area: "wishlist",
        message: "Anything",
      })
    ).rejects.toThrow(/choose an area/i);
  });

  it("refuses a message that is only whitespace", async () => {
    await expect(
      feedback.submit(acme.staff.userId, acme.orgId, {
        area: "other",
        message: "   \n\t  ",
      })
    ).rejects.toThrow(/cannot be empty/i);
  });

  it("refuses a message longer than the cap", async () => {
    await expect(
      feedback.submit(acme.staff.userId, acme.orgId, {
        area: "other",
        message: "x".repeat(FEEDBACK_MAX_LENGTH + 1),
      })
    ).rejects.toThrow(/characters or fewer/i);
  });

  /* The cap is measured after trimming, so trailing newlines cannot fail it. */
  it("accepts a message that only exceeds the cap before trimming", async () => {
    const created = await feedback.submit(acme.staff.userId, acme.orgId, {
      area: "other",
      message: `  ${"x".repeat(FEEDBACK_MAX_LENGTH)}  `,
    });

    const row = await prisma.feedback.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.message).toHaveLength(FEEDBACK_MAX_LENGTH);
  });
});

describe("the platform queue", () => {
  /*
   * The point of the feature. Every other read in this codebase is scoped to
   * one tenant; this one must not be, and a scoping bug would look like a queue
   * that simply had less in it.
   */
  it("returns messages from every organisation", async () => {
    await seed(acme, "scheduling", "From Acme");
    await seed(other, "billing", "From the other org");

    const { rows, total } = await feedback.getQueue({});

    expect(total).toBe(2);
    expect(rows.map((row) => row.organization.id).sort()).toEqual(
      [acme.orgId, other.orgId].sort()
    );
  });

  it("hides archived messages unless asked for them", async () => {
    await seed(acme, "other", "Live one");
    await seed(acme, "other", "Cleared one", { archivedAt: new Date() });

    const live = await feedback.getQueue({});
    expect(live.total).toBe(1);
    expect(live.rows[0].message).toBe("Live one");

    const all = await feedback.getQueue({ includeArchived: true });
    expect(all.total).toBe(2);
  });

  it("narrows to one area", async () => {
    await seed(acme, "scheduling", "About the roster");
    await seed(acme, "billing", "About the invoice");

    const { rows, total } = await feedback.getQueue({ area: "billing" });

    expect(total).toBe(1);
    expect(rows[0].message).toBe("About the invoice");
  });

  /* An unknown area is ignored rather than matching nothing. */
  it("treats an area outside the list as no filter at all", async () => {
    await seed(acme, "scheduling", "One");
    await seed(acme, "billing", "Two");

    const { total } = await feedback.getQueue({ area: "not-an-area" });

    expect(total).toBe(2);
  });

  /*
   * `total` counts matches, not the page.
   *
   * The footer reads from it, and reporting a page size as a match count is how
   * "25 messages" comes to mean "at least 25, we did not look".
   */
  it("reports the match count rather than the size of the page", async () => {
    const overflow = FEEDBACK_PAGE_SIZE + 2;
    for (let i = 0; i < overflow; i++) {
      await seed(acme, "other", `Message ${i}`);
    }

    const first = await feedback.getQueue({});
    expect(first.rows).toHaveLength(FEEDBACK_PAGE_SIZE);
    expect(first.total).toBe(overflow);

    const second = await feedback.getQueue({}, 1);
    expect(second.rows).toHaveLength(2);
  });

  /*
   * A page past the end is clamped, not answered emptily.
   *
   * Two callers reach this. A crafted `?page=1e21` multiplies into a `skip`
   * no integer column accepts, which answered 500 for a bad request. And the
   * console strands itself: archive the last row on the last page and the page
   * it is standing on stops existing, so the queue reads empty while the
   * earlier pages are full.
   */
  it("clamps a page past the end and reports the one it served", async () => {
    await seed(acme, "other", "The only message");

    const result = await feedback.getQueue({}, 40);

    expect(result.page).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("survives a page number too large to be a database offset", async () => {
    await seed(acme, "other", "Still here");

    const result = await feedback.getQueue({}, 1e21);

    expect(result.page).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  it("returns an empty page rather than failing when there is nothing", async () => {
    const { rows, total } = await feedback.getQueue({});

    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});

describe("area counts", () => {
  it("counts live messages per area, across organisations", async () => {
    await seed(acme, "scheduling", "One");
    await seed(other, "scheduling", "Two");
    await seed(acme, "billing", "Three");

    const { counts, total } = await feedback.getAreaCounts();

    expect(total).toBe(3);
    expect(counts).toEqual(
      expect.arrayContaining([
        { area: "scheduling", count: 2 },
        { area: "billing", count: 1 },
      ])
    );
  });

  it("leaves archived messages out of the counts", async () => {
    await seed(acme, "scheduling", "Live");
    await seed(acme, "scheduling", "Cleared", { archivedAt: new Date() });

    const { counts } = await feedback.getAreaCounts();

    expect(counts).toEqual([{ area: "scheduling", count: 1 }]);
  });

  /* Older than the window, so it is not part of "what people are saying now". */
  it("ignores messages older than the window", async () => {
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await seed(acme, "scheduling", "Ancient", { createdAt: longAgo });
    await seed(acme, "scheduling", "Recent");

    const { total } = await feedback.getAreaCounts();

    expect(total).toBe(1);
  });
});

describe("archiving", () => {
  it("archives and restores the same row", async () => {
    const row = await seed(acme, "other", "Tidy me away");

    const archived = await feedback.setArchived(row.id, true);
    expect(archived.archivedAt).not.toBeNull();

    const restored = await feedback.setArchived(row.id, false);
    expect(restored.archivedAt).toBeNull();
  });

  it("refuses an id that does not exist", async () => {
    await expect(feedback.setArchived("no-such-id", true)).rejects.toThrow(
      /not found/i
    );
  });
});
