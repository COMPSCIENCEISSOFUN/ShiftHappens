/**
 * My Shift History (Boundary Layer)
 * GET /api/organizations/[orgId]/my-history
 *
 * The signed-in member's own finished shifts, with totals for the range.
 *
 * ## No membershipId parameter
 *
 * The membership is resolved from the session and the org in the path, so
 * "whose history" is not something a caller can ask for. An endpoint that took
 * an id would need an authorisation rule on every request to keep one member
 * out of another's record, and the rule that is never written is the one that
 * cannot be got wrong.
 *
 * ## Why admins get a 403 rather than an empty list
 *
 * `canBeRostered` excludes company admins from the eligibility engine, from
 * `assignStaff` and from `findSchedulableStaff`, so an admin's history is
 * permanently empty — and an empty page says "you have worked no shifts", which
 * for someone who cannot be rostered at all is not the reason. Same predicate
 * the sidebar uses to decide whether to show the link, so the menu and the
 * endpoint cannot disagree.
 */
import { NextRequest, NextResponse } from "next/server";

import { TaskAssignmentService } from "@/services/task-assignment.service";
import { AccessService } from "@/services/access.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { canBeRostered } from "@/lib/role-config";
import { SHIFT_OUTCOMES, type ShiftOutcome } from "@/lib/shift-outcome";

const assignmentService = new TaskAssignmentService();
const accessService = new AccessService();

/**
 * Reads a YYYY-MM-DD or ISO date from the query string.
 *
 * Returns `undefined` for absent and throws for present-but-unparseable. An
 * unreadable date silently becoming "no filter" is the failure mode worth
 * avoiding here: the page would show the member's whole history under a heading
 * saying "last 30 days", and every figure on it would be wrong in a way that
 * looks entirely plausible.
 */
function readDate(value: string | null, field: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a date`);
  }
  return parsed;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.status !== "active") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!canBeRostered(membership.role)) {
      return NextResponse.json(
        { error: "Only staff and managers are rostered onto shifts" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);

    let from: Date | undefined;
    let to: Date | undefined;
    try {
      from = readDate(searchParams.get("from"), "from");
      to = readDate(searchParams.get("to"), "to");
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid date" },
        { status: 400 }
      );
    }

    /*
     * An unrecognised outcome is dropped rather than refused.
     *
     * It reaches the route only from a stale bookmark or a hand-written URL,
     * and the cost of the two answers is asymmetric: dropping it shows the
     * member their whole history, while a 400 shows them an error page for a
     * link they clicked. Neither is what they asked for; only one is useful.
     * A wrong FILTER would be different — that would silently answer a
     * different question — but an absent one is visibly the unfiltered view.
     */
    const outcomeParam = searchParams.get("outcome");
    const outcome = SHIFT_OUTCOMES.includes(outcomeParam as ShiftOutcome)
      ? (outcomeParam as ShiftOutcome)
      : undefined;

    const pageParam = Number(searchParams.get("page") ?? "1");
    const sizeParam = Number(searchParams.get("pageSize") ?? "20");

    const history = await assignmentService.getHistory(membership.id, {
      from,
      to,
      outcome,
      departmentId: searchParams.get("department") || undefined,
      // Trimmed and length-capped at the boundary. `contains` on an unbounded
      // string is the caller choosing how much work the database does.
      search: (searchParams.get("search") || "").trim().slice(0, 100) || undefined,
      // NaN would flow into Math.max and come back NaN, which Prisma rejects at
      // the driver with a message nobody can act on. A page number that is not
      // a number is page one.
      page: Number.isFinite(pageParam) ? pageParam : 1,
      pageSize: Number.isFinite(sizeParam) ? sizeParam : 20,
    });

    return NextResponse.json(history);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("must come before")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
