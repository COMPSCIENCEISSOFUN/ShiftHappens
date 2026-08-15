/**
 * Calendar Subscribe Feed (Boundary Layer)
 * GET /api/calendar/[token] — the caller's shifts as iCalendar
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
