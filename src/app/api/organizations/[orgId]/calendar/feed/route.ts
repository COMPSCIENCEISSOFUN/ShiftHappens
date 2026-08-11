/**
 * Calendar Feed Management (Boundary Layer)
 * GET  /api/organizations/[orgId]/calendar/feed — this member's subscribe URL
 * POST /api/organizations/[orgId]/calendar/feed — replace it
 *
 * ## No permission, by design
 *
 * A feed is your own shifts. There is nothing here another member could read
 * and nothing an administrator needs to grant — the membership IS the
 * authorisation, resolved from the session, and a caller can only ever reach
 * their own row. Inventing a permission would add an unticked checkbox to every
 * custom role, which is the trap the leave routes documented.
 *
 * ## Why the plan is NOT checked here
 *
 * Deliberately. The refusal belongs on the feed itself, which is polled long
 * after anybody visited this page: an organisation that downgrades must stop a
 * calendar already sitting in somebody's phone, and no check made at subscribe
 * time can do that. Showing the URL on a Free plan is harmless — following it
 * returns a calendar that explains the plan.
 */
import { NextRequest, NextResponse } from "next/server";
import { CalendarFeedService } from "@/services/calendar-feed.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const feedService = new CalendarFeedService();
const accessService = new AccessService();

async function membershipFor(userId: string, orgId: string) {
  return accessService.getMembership(userId, orgId);
}

/**
 * 403, matching every other org-scoped route, rather than the 404 this first
 * had.
 *
 * The 404 was reasoned from a real principle — never confirm that an
 * organisation id is real — and the principle does not apply here, because it
 * is only worth anything if it holds EVERYWHERE. Thirty sibling routes answer
 * 403 to a non-member, so an attacker learns the same fact from any of them and
 * this route's silence buys nothing. What it did buy was an inconsistency: a
 * caller cannot tell "you are not a member" from "there is no such feed", and
 * the contract sweep exists to stop exactly that drift.
 */
function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const membership = await membershipFor(user.id, orgId);
    if (!membership) return forbidden();

    return NextResponse.json(await feedService.getFeedToken(membership.id));
  } catch (error) {
    console.error("[Calendar Feed Error]", error);
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
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipFor(user.id, orgId);
    if (!membership) return forbidden();

    return NextResponse.json(await feedService.regenerate(membership.id));
  } catch (error) {
    console.error("[Calendar Feed Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
