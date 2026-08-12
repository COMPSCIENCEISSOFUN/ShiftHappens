/**
 * Member Review API (Boundary Layer)
 * GET  /api/organizations/[orgId]/reviews — this member's own review
 * POST /api/organizations/[orgId]/reviews — write or rewrite it
 *
 * Ungated, like feedback and for the same reason: every member may have an
 * opinion of the product, and a permission here would let an organisation
 * decide which of its own people are allowed one. Rate limited instead.
 *
 * GET returns only the caller's own review. There is no endpoint here for
 * reading anyone else's — the published ones are read on the server as the
 * landing page renders.
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { submitReviewSchema } from "@/lib/validations";
import { AccessService } from "@/services/access.service";
import { ReviewService } from "@/services/review.service";

const access = new AccessService();
const reviews = new ReviewService();

/** Rewrites per minute, per person. */
const REVIEW_LIMIT = 5;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const membership = await access.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // null is a real answer — "you have not written one" — not a 404.
    return NextResponse.json({ review: await reviews.getMine(user.id, orgId) });
  } catch (error) {
    console.error("[GET /api/organizations/[orgId]/reviews]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const membership = await access.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const limit = rateLimit(`review:${user.id}`, REVIEW_LIMIT);
    if (!limit.success) {
      return NextResponse.json(
        {
          error: `That was not saved — too many changes at once. Try again in ${Math.ceil(limit.resetIn / 1000)} seconds.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) },
        }
      );
    }

    const parsed = submitReviewSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const saved = await reviews.submit(user.id, orgId, parsed.data);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save that";
    if (
      message.startsWith("Choose a rating") ||
      message.startsWith("Please write") ||
      message.startsWith("A review must be")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (message === "You are not a member of this organization") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("[POST /api/organizations/[orgId]/reviews]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
