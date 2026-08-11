/**
 * Calendar subscribe feeds (Control Layer) — US-81.
 *
 * ## Why this is a SUBSCRIBE feed and not a download
 *
 * A download is a snapshot: the moment a shift moves, the file in somebody's
 * calendar is wrong and nothing tells them. The story asks for a feed a client
 * polls, so the rota in their phone is the rota in the product. That is the
 * whole feature; the .ics serialisation is the easy half.
 *
 * ## The consequence, which shapes everything here
 *
 * Calendar clients send no session, no cookie and no header. There is nowhere
 * to put an authorisation, so the token in the URL is the credential — which
 * means this service runs with NO authenticated user and must resolve every
 * question from the token alone: which membership, which organisation, whether
 * that organisation still pays for this, and whether that person is still
 * active.
 *
 * Each of those is a refusal an ordinary route gets from `requirePermission`
 * and this one has to ask for itself. They are listed in `feedFor` in the order
 * they are checked, and the order matters: a deactivated member of a paying
 * organisation and an active member of a downgraded one are different answers.
 */
import { CalendarFeedRepository } from "@/repositories/calendar-feed.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { SubscriptionService } from "@/services/subscription.service";
import { buildCalendar, type CalendarEvent } from "@/lib/ical";

/**
 * How much of the rota the feed carries.
 *
 * A calendar is a forward-looking object, and a feed that grew without bound
 * would resend the person's whole employment history on every poll. Thirty days
 * back keeps last week visible for anybody reconciling their hours; ninety
 * forward is beyond any horizon the product schedules to.
 */
const DAYS_BACK = 30;
const DAYS_FORWARD = 90;

/** At most one `lastPolledAt` write per feed per five minutes. */
const POLL_WRITE_FLOOR_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export class CalendarFeedService {
  private feedRepo = new CalendarFeedRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private subscriptionService = new SubscriptionService();

  /** The caller's own subscribe URL, created on first ask. */
  async getFeedToken(membershipId: string) {
    const feed = await this.feedRepo.ensure(membershipId);
    return { token: feed.token, lastPolledAt: feed.lastPolledAt };
  }

  /** Replaces the token. Any client still holding the old URL gets a 404. */
  async regenerate(membershipId: string) {
    const feed = await this.feedRepo.regenerate(membershipId);
    return { token: feed.token, lastPolledAt: feed.lastPolledAt };
  }

  /**
   * The calendar for a token, or `null` if the token resolves to nothing.
   *
   * `null` is for "no such feed" ONLY. Every other refusal returns a valid
   * calendar carrying a single explanatory event, because a calendar client
   * given an error shows its owner nothing — their shifts simply stop
   * appearing, which reads as an empty rota rather than as a problem. An
   * unknown token is the one case where saying nothing is right: it is either a
   * regenerated URL or somebody guessing, and neither deserves an explanation.
   */
  async feedFor(token: string, now: Date = new Date()): Promise<string | null> {
    const feed = await this.feedRepo.findByToken(token);
    if (!feed) return null;

    const { membership } = feed;
    const owner = membership.user.name || membership.user.email;
    const name = `${membership.organization.name} shifts`;

    /*
     * Deactivated first. Somebody who has left keeps the URL in their phone,
     * and "your access has ended" is both true and the more useful thing to say
     * than anything about a plan.
     */
    if (membership.status !== "active") {
      return this.notice(
        name,
        "Shift sync has ended",
        `Your access to ${membership.organization.name} has ended.`,
        feed.id,
        now
      );
    }

    /*
     * A suspended organisation stops syncing.
     *
     * The one place this product lets a READ continue while a suspension is in
     * force would otherwise be the one read that leaves the building. Every
     * other screen needs somebody signed in and looking; this keeps delivering
     * the roster to a phone weeks later, with no session, no audit entry and
     * nobody aware it is still happening. A suspension is meant to be a stop.
     *
     * Checked after the membership and before the plan: a suspended
     * organisation's billing state is nobody's business but theirs, and
     * "temporarily unavailable" is the true statement that gives away least.
     */
    if (membership.organization.status !== "active") {
      return this.notice(
        name,
        "Shift sync is paused",
        `${membership.organization.name} is not currently active. Your shifts are still in the app.`,
        feed.id,
        now
      );
    }

    const allowed = await this.subscriptionService.canUseFeature(
      membership.organizationId,
      "calendar_sync"
    );
    if (!allowed) {
      return this.notice(
        name,
        "Shift sync is not available on this plan",
        `${membership.organization.name} is on a plan that does not include calendar sync. Your shifts are still in the app.`,
        feed.id,
        now
      );
    }

    const from = new Date(now.getTime() - DAYS_BACK * DAY_MS);
    const until = new Date(now.getTime() + DAYS_FORWARD * DAY_MS);
    /*
     * Bounded in the QUERY, not filtered afterwards. The window and the
     * occupied-status rule both live in the repository call now — this used to
     * fetch every assignment the person had ever held and discard most of them,
     * on an endpoint polled hourly by every subscriber.
     */
    const assignments = await this.assignmentRepo.findForCalendarFeed(
      membership.id,
      from,
      until
    );

    const events: CalendarEvent[] = [];
    for (const assignment of assignments) {
      const task = assignment.task;
      // Narrowing for the type checker; the query already excludes both.
      if (!task.scheduledStart || !task.scheduledEnd) continue;

      events.push({
        /*
         * Derived from the ASSIGNMENT id, which is stable for the life of the
         * booking. Anything volatile — a hash of the times, an index — makes
         * every poll look like a deletion and a recreation to the client, and
         * most of them re-notify on a new event. The person would be reminded
         * about the same shift hourly.
         */
        uid: `assignment-${assignment.id}@smart-task-allocation`,
        start: task.scheduledStart,
        end: task.scheduledEnd,
        summary: task.department?.name
          ? `${task.title} (${task.department.name})`
          : task.title,
        description: task.description,
        status: assignment.status === "pending" ? "tentative" : "confirmed",
      });
    }

    await this.feedRepo.touch(feed.id, now, POLL_WRITE_FLOOR_MS);
    return buildCalendar({ name: `${name} — ${owner}`, events, now });
  }

  /**
   * A calendar whose only content is an explanation.
   *
   * An all-day-ish event on today, so it is visible without the reader hunting.
   * The UID is fixed per feed and per reason, so the client replaces the notice
   * rather than accumulating one per poll — the same stability argument as the
   * shifts, for the same reason.
   */
  private async notice(
    calendarName: string,
    summary: string,
    description: string,
    feedId: string,
    now: Date
  ) {
    await this.feedRepo.touch(feedId, now, POLL_WRITE_FLOOR_MS);
    return buildCalendar({
      name: calendarName,
      now,
      events: [
        {
          uid: `notice-${feedId}@smart-task-allocation`,
          start: now,
          end: new Date(now.getTime() + 60 * 60 * 1000),
          summary,
          description,
          status: "confirmed",
        },
      ],
    });
  }
}
