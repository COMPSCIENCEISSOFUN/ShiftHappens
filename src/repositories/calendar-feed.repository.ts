/**
 * Calendar subscribe feeds (Entity Layer).
 *
 * One row per membership per kind. See the model's docblock for why the token
 * is the whole credential and why regenerating replaces it in place rather than
 * writing a second row.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * A token with enough entropy that guessing is not an attack.
 *
 * 32 bytes, base64url. This is the only bearer credential in the product and it
 * sits in a URL, so it is generated with `randomBytes` rather than anything
 * derived from the membership — a token computed from an id is a token an
 * attacker can compute too, and `cuid` ids appear in other responses.
 */
export function newFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

export class CalendarFeedRepository {
  async findByToken(token: string) {
    return prisma.calendarFeed.findUnique({
      where: { token },
      include: {
        membership: {
          select: {
            id: true,
            status: true,
            organizationId: true,
            user: { select: { name: true, email: true } },
            organization: { select: { id: true, name: true, status: true } },
          },
        },
      },
    });
  }

  async findForMembership(membershipId: string, kind = "personal") {
    return prisma.calendarFeed.findUnique({
      where: { membershipId_kind: { membershipId, kind } },
    });
  }

  /**
   * The feed for this membership, created on first ask.
   *
   * An upsert rather than find-then-create: two tabs opening the page at once
   * would otherwise race on the unique key and one would see a 500 for a read.
   */
  async ensure(membershipId: string, kind = "personal") {
    return prisma.calendarFeed.upsert({
      where: { membershipId_kind: { membershipId, kind } },
      update: {},
      create: { membershipId, kind, token: newFeedToken() },
    });
  }

  /**
   * Replaces the token, which is what revocation means here.
   *
   * The old value stops resolving the instant it is overwritten. Nothing is
   * deleted, so the person keeps one feed rather than accumulating dead rows —
   * and a client still polling the old URL gets a 404, which is the only signal
   * the protocol has.
   */
  async regenerate(membershipId: string, kind = "personal") {
    return prisma.calendarFeed.upsert({
      where: { membershipId_kind: { membershipId, kind } },
      update: { token: newFeedToken(), lastPolledAt: null },
      create: { membershipId, kind, token: newFeedToken() },
    });
  }

  /** Records a poll, at most once per `floorMs`. See the model's docblock. */
  async touch(id: string, at: Date, floorMs: number) {
    return prisma.calendarFeed.updateMany({
      where: {
        id,
        OR: [
          { lastPolledAt: null },
          { lastPolledAt: { lt: new Date(at.getTime() - floorMs) } },
        ],
      },
      data: { lastPolledAt: at },
    });
  }
}
