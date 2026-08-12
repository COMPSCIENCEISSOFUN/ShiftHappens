/**
 * Customer reviews.
 *
 * The rule the whole design rests on is that editing an approved review
 * withdraws it. Without that, a member is approved for one paragraph and can
 * then replace it with another, on the public landing page, with somebody
 * else's approval attached to it.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import { ReviewService } from "@/services/review.service";
import { REVIEW_MAX_LENGTH } from "@/lib/review-status";

import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const reviews = new ReviewService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("rev");
});

/** Writes straight to the row, for the reads that do not care how it got there. */
async function approve(membershipId: string) {
  await prisma.review.update({
    where: { membershipId },
    data: { status: "approved" },
  });
}

describe("writing a review", () => {
  it("starts life awaiting a decision", async () => {
    const saved = await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "Saves me a Sunday evening",
    });

    expect(saved.status).toBe("pending");
    expect(await reviews.getPublished()).toEqual([]);
  });

  /*
   * One per member, enforced by a unique key rather than by a check here — so a
   * second submission cannot slip through a race between reading and writing.
   */
  it("replaces the member's own review rather than adding another", async () => {
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 3,
      body: "First thoughts",
    });
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "Second thoughts",
    });

    const all = await prisma.review.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("Second thoughts");
    expect(all[0].rating).toBe(5);
  });

  /* The one that matters. */
  it("takes an approved review off the site when its author edits it", async () => {
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "Approved words",
    });
    await approve(tenant.staff.membershipId);
    expect(await reviews.getPublished()).toHaveLength(1);

    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 1,
      body: "Completely different words",
    });

    expect(await reviews.getPublished()).toEqual([]);
    const mine = await reviews.getMine(tenant.staff.userId, tenant.orgId);
    expect(mine?.status).toBe("pending");
  });

  it("refuses a member of another organisation", async () => {
    const other = await createTenant("rev-other");

    await expect(
      reviews.submit(other.staff.userId, tenant.orgId, {
        rating: 5,
        body: "Not my organisation",
      })
    ).rejects.toThrow(/not a member/i);

    expect(await prisma.review.count()).toBe(0);
  });

  it.each([[0], [6], [1.5]])("refuses a rating of %s", async (rating) => {
    await expect(
      reviews.submit(tenant.staff.userId, tenant.orgId, {
        rating,
        body: "Fine words",
      })
    ).rejects.toThrow(/rating between/i);
  });

  it("refuses a body that is only whitespace", async () => {
    await expect(
      reviews.submit(tenant.staff.userId, tenant.orgId, {
        rating: 5,
        body: "   \n  ",
      })
    ).rejects.toThrow(/write a few words/i);
  });

  it("refuses a body past the cap", async () => {
    await expect(
      reviews.submit(tenant.staff.userId, tenant.orgId, {
        rating: 5,
        body: "x".repeat(REVIEW_MAX_LENGTH + 1),
      })
    ).rejects.toThrow(/characters or fewer/i);
  });
});

describe("the member's own view", () => {
  it("returns null before they have written one", async () => {
    expect(await reviews.getMine(tenant.staff.userId, tenant.orgId)).toBeNull();
  });

  it("returns null for somebody with no membership here", async () => {
    const other = await createTenant("rev-outsider");

    expect(await reviews.getMine(other.staff.userId, tenant.orgId)).toBeNull();
  });
});

describe("what the landing page reads", () => {
  it("returns approved reviews only", async () => {
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "Published one",
    });
    await reviews.submit(tenant.manager.userId, tenant.orgId, {
      rating: 4,
      body: "Still waiting",
    });
    await approve(tenant.staff.membershipId);

    const published = await reviews.getPublished();

    expect(published.map((review) => review.body)).toEqual(["Published one"]);
  });

  it("carries the author and organisation the page prints beside the words", async () => {
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "With attribution",
    });
    await approve(tenant.staff.membershipId);

    const [review] = await reviews.getPublished();

    expect(review.membership.user.name).toBeTruthy();
    expect(review.organization.name).toBeTruthy();
  });

  it("returns nothing when none are approved", async () => {
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "Awaiting",
    });

    expect(await reviews.getPublished()).toEqual([]);
  });
});

describe("moderating", () => {
  beforeEach(async () => {
    await reviews.submit(tenant.staff.userId, tenant.orgId, {
      rating: 5,
      body: "Decide about me",
    });
  });

  it("shows what is waiting by default", async () => {
    const { rows, total } = await reviews.getQueue();

    expect(total).toBe(1);
    expect(rows[0].status).toBe("pending");
  });

  it("publishes on approval", async () => {
    const [row] = (await reviews.getQueue()).rows;

    await reviews.setStatus(row.id, "approved");

    expect(await reviews.getPublished()).toHaveLength(1);
  });

  it("keeps a rejected review off the site without deleting it", async () => {
    const [row] = (await reviews.getQueue()).rows;

    await reviews.setStatus(row.id, "rejected");

    expect(await reviews.getPublished()).toEqual([]);
    expect(await prisma.review.count()).toBe(1);
    const mine = await reviews.getMine(tenant.staff.userId, tenant.orgId);
    expect(mine?.status).toBe("rejected");
  });

  /*
   * Only the author returns a review to pending, by editing it. A moderator who
   * could do it would be undoing their own approval in a way the author never
   * sees and cannot explain.
   */
  it("refuses to put a review back to pending", async () => {
    const [row] = (await reviews.getQueue()).rows;

    await expect(reviews.setStatus(row.id, "pending")).rejects.toThrow(
      /only be approved or rejected/i
    );
  });

  it("refuses a status that is not one of the three", async () => {
    const [row] = (await reviews.getQueue()).rows;

    await expect(reviews.setStatus(row.id, "published")).rejects.toThrow(
      /only be approved or rejected/i
    );
  });

  it("refuses an id that does not exist", async () => {
    await expect(reviews.setStatus("no-such-id", "approved")).rejects.toThrow(
      /not found/i
    );
  });

  it("counts every state, whichever one is being shown", async () => {
    const [row] = (await reviews.getQueue()).rows;
    await reviews.setStatus(row.id, "approved");

    const { counts } = await reviews.getQueue("pending");

    expect(counts).toEqual([{ status: "approved", count: 1 }]);
  });

  it("clamps a page past the end", async () => {
    const result = await reviews.getQueue("pending", 40);

    expect(result.page).toBe(0);
    expect(result.rows).toHaveLength(1);
  });
});
