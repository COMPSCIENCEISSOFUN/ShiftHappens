/**
 * Calendar Subscribe Feed (Boundary Layer)
 * GET /api/calendar/[token] — the caller's shifts as iCalendar
 *
 * ## Public by necessity, not by choice
 *
 * Google Calendar and Apple Calendar poll a URL on a timer. They send no
 * cookie, no session and no Authorization header, and there is no negotiation
 * step in which one could be supplied. So the token in the path IS the
 * credential — the only bearer credential in the product.
 *
 * That makes this the one route where `getAuthenticatedUser` is deliberately
 * absent, and it is why everything the session would normally have proved is
 * proved in the service from the token instead: which membership, which
 * organisation, whether the member is still active, and whether the plan still
 * includes this. The route's only job is to refuse quickly and to say the right
 * thing in the two cases the protocol can express.
 *
 * ## Why an unknown token is a 404 and everything else is a 200
 *
 * A calendar client handed a 4xx shows its owner nothing — the shifts simply
 * stop appearing, which reads as an empty rota. So a deactivated member or a
 * downgraded organisation still gets a valid calendar, carrying one event that
 * explains itself. An unknown token gets a bare 404: it is a regenerated URL or
 * somebody guessing, and neither is owed an explanation.
 *
 * ## Rate limited even though it is idempotent
 *
 * Reading costs several queries and anybody holding the URL can call it as
 * often as they like. Keyed on the token, so one leaked feed cannot degrade
 * anybody else's.
 */
import { NextRequest, NextResponse } from "next/server";
import { CalendarFeedService } from "@/services/calendar-feed.service";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const feedService = new CalendarFeedService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    // Next 16 — route params arrive as a Promise.
    const { token } = await params;

    const limit = rateLimit(`calendar:${token}`, 30);
    if (!limit.success) {
      /*
       * `Retry-After`, because the caller is a machine on a timer rather than a
       * person who can be told to wait. A calendar client given a bare 429 with
       * no interval backs off on whatever schedule it likes, and several of
       * them simply retry at the same rate.
       */
      return new NextResponse("Too many requests", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) },
      });
    }

    const body = await feedService.feedFor(token);
    if (body === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        /*
         * Named so a manual download is recognisable, and marked no-store so a
         * proxy between the client and here cannot serve last hour's rota. The
         * feed's whole value is being current.
         */
        "Content-Disposition": 'inline; filename="shifts.ics"',
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("[Calendar Feed Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
