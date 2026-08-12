/**
 * Member Feedback API (Boundary Layer)
 * POST /api/organizations/[orgId]/feedback — send product feedback
 *
 * ## Both gates, answered
 *
 * Neither applies, and that is the answer rather than an oversight. There is no
 * permission because every member may say what they think of the product — a
 * permission here would mean an organisation could configure some of its people
 * out of being heard. There is no plan tier because feedback is not a feature
 * sold to the tenant; the beneficiary is us.
 *
 * Rate limiting does the work a gate would otherwise do. A form that writes a
 * row on every submit and is reachable by every member is the obvious way to
 * fill a table, and a person with something to say does not need ten sends a
 * minute to say it.
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { submitFeedbackSchema } from "@/lib/validations";
import { AccessService } from "@/services/access.service";
import { FeedbackService } from "@/services/feedback.service";

const access = new AccessService();
const feedback = new FeedbackService();

/** Sends per minute, per person. */
const FEEDBACK_LIMIT = 5;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    /*
     * Membership, not permission.
     *
     * Deliberately the same 403 every sibling route answers for a stranger:
     * whether an organisation exists is not something an outsider learns here.
     */
    const membership = await access.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const limit = rateLimit(`feedback:${user.id}`, FEEDBACK_LIMIT);
    if (!limit.success) {
      return NextResponse.json(
        {
          error: `That was not sent — too many messages at once. Your text is still here; try again in ${Math.ceil(limit.resetIn / 1000)} seconds.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) },
        }
      );
    }

    const parsed = submitFeedbackSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const created = await feedback.submit(user.id, orgId, parsed.data);
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send feedback";
    // The service raises these for input it can describe; letting them fall
    // through to 500 would report the sender's mistake as ours.
    const known =
      message.startsWith("Choose an area") ||
      message.startsWith("Feedback cannot be empty") ||
      message.startsWith("Feedback must be");
    if (known) return NextResponse.json({ error: message }, { status: 400 });
    if (message === "You are not a member of this organization") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    console.error("[POST /api/organizations/[orgId]/feedback]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
