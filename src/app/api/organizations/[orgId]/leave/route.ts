/**
 * Leave Register API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/leave — leave requests, filtered
 *
 * Query: view, departmentId, from, to, search, page — all optional.
 *
 * Department-scoped: a manager sees their own members' requests, an admin sees
 * everyone's. The scope comes from `departmentScopeFor(membership)` and never
 * from the query string, which is the mistake four reporting surfaces made
 * before the 2026-08-05 audit — and this endpoint now TAKES a department in the
 * query string, which is exactly the shape that invited it. The parameter is a
 * narrowing applied inside the scope, resolved in the service, where the two
 * are intersected into one list of memberships before any row is read.
 *
 * ## Why unrecognised filter values are ignored rather than rejected
 *
 * A stale bookmark with `?view=archived` should show the default list, not a
 * 400 with nothing on the screen. Nothing is trusted either way: `view` is
 * checked against the closed set, and every other parameter reaches a query
 * as a bound value.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { isLeaveView } from "@/lib/leave-filters";
import { DATE_RANGE_MESSAGE } from "@/lib/date-range";

const availService = new AvailabilityService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    /*
     * Gated on `members:request_availability` — the permission that already
     * means "may act on somebody else's availability". Inventing a
     * `leave:review` permission would add a checkbox to every custom role that
     * nobody has ticked, so every existing manager would silently lose the
     * ability the moment a custom role was assigned to them.
     */
    const gate = await requirePermission(
      user.id,
      orgId,
      "members:request_availability"
    );
    if (!gate.ok) return gate.response;

    const q = request.nextUrl.searchParams;
    const view = q.get("view");
    const page = Number(q.get("page"));

    const register = await availService.getLeaveRegister(
      orgId,
      departmentScopeFor(gate.membership),
      {
        view: isLeaveView(view) ? view : undefined,
        departmentId: q.get("departmentId"),
        from: q.get("from"),
        to: q.get("to"),
        // Names and emails only. `reason` is free text somebody typed about
        // their own life, and a field people write honestly is one nobody can
        // sweep for keywords.
        search: q.get("search"),
        page: Number.isFinite(page) && page > 0 ? page : 1,
      }
    );
    return NextResponse.json(register);
  } catch (error) {
    /*
     * 400 for a filter that cannot mean anything — a reversed or impossible
     * date range. Answered on the handler that can raise it rather than left to
     * fall through to a 500, which would tell the screen nothing it can show
     * the reader.
     */
    if (
      error instanceof Error &&
      Object.values(DATE_RANGE_MESSAGE).includes(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[Leave Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
