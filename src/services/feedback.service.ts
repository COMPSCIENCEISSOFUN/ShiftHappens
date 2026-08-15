/**
 * Product feedback (Control layer).
 */
import { FEEDBACK_MAX_LENGTH, isFeedbackArea } from "@/lib/feedback-areas";
import { FeedbackRepository } from "@/repositories/feedback.repository";
import { MembershipRepository } from "@/repositories/membership.repository";

/** How far back the area counts look. */
export const FEEDBACK_WINDOW_DAYS = 90;

/** One page of the platform queue. */
export const FEEDBACK_PAGE_SIZE = 25;

export interface SubmitFeedbackInput {
  area: string;
  message: string;
}

export class FeedbackService {
  private feedbackRepo = new FeedbackRepository();
  private membershipRepo = new MembershipRepository();

  /**
   * Send feedback as a member of an organisation.
   *
   * The membership is resolved here rather than trusted from the request: the
   * caller supplies an organisation id, and without this a member of org A
   * could file feedback that arrives labelled as org B — which matters because
   * the queue shows the organisation next to the words.
   */
  async submit(
    userId: string,
    organizationId: string,
    input: SubmitFeedbackInput
  ) {
    if (!isFeedbackArea(input.area)) {
      throw new Error("Choose an area for your feedback");
    }

    const message = input.message.trim();
    if (message.length === 0) {
      throw new Error("Feedback cannot be empty");
    }
    if (message.length > FEEDBACK_MAX_LENGTH) {
      throw new Error(
        `Feedback must be ${FEEDBACK_MAX_LENGTH} characters or fewer`
      );
    }

    const membership = await this.membershipRepo.findByUserAndOrg(
      userId,
      organizationId
    );
    if (!membership) {
      throw new Error("You are not a member of this organization");
    }

    return this.feedbackRepo.create({
      organizationId,
      membershipId: membership.id,
      area: input.area,
      message,
    });
  }

  /**
   * The platform admin's queue — every tenant, newest first.
   *
   * `total` is counted rather than read off the page. A footer that reports the
   * page size as the match count is how "25 messages" comes to mean "at least
   * 25 messages, we did not look".
   */
  async getQueue(
    filters: { area?: string; includeArchived?: boolean },
    requestedPage = 0
  ) {
    // No cast. The parameter is `unknown` to the guard, so an assertion here
    // changes nothing at runtime and would silently disable the check if the
    // parameter were ever tightened to `FeedbackArea`.
    const area = isFeedbackArea(filters.area) ? filters.area : undefined;
    const where = { area, includeArchived: filters.includeArchived ?? false };

    /*
     * Counted first, so the page can be clamped to one that exists.
     *
     * Two sequential queries rather than two parallel ones, and worth it: an
     * unclamped page is reachable two ways. A caller can ask for `?page=1e21`,
     * which multiplies into a `skip` no integer column accepts and answers 500
     * for what is a bad request. And the console can strand itself — archive
     * the only row on the last page and the page it is standing on no longer
     * exists, so the queue reads as empty while the earlier pages are still
     * full. Returning the page actually served lets the caller correct itself.
     */
    const total = await this.feedbackRepo.countQueue(where);
    const lastPage = Math.max(0, Math.ceil(total / FEEDBACK_PAGE_SIZE) - 1);
    const page = Math.min(Math.max(0, Math.floor(requestedPage) || 0), lastPage);

    const rows = await this.feedbackRepo.findQueue(
      where,
      FEEDBACK_PAGE_SIZE,
      page * FEEDBACK_PAGE_SIZE
    );

    return { rows, total, page, pageSize: FEEDBACK_PAGE_SIZE };
  }

  /**
   * How many live messages sit in each area.
   *
   * Counting is what SQL is for. This is exact, costs one query, and is
   * available the moment the first message arrives — which is the whole reason
   * the sender picks the area rather than a model guessing it.
   */
  async getAreaCounts(windowDays = FEEDBACK_WINDOW_DAYS) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const counts = await this.feedbackRepo.countByArea(since);
    return {
      counts,
      windowDays,
      total: counts.reduce((sum, row) => sum + row.count, 0),
    };
  }

  async setArchived(feedbackId: string, archived: boolean) {
    const existing = await this.feedbackRepo.findById(feedbackId);
    if (!existing) throw new Error("Feedback not found");
    return this.feedbackRepo.setArchived(feedbackId, archived ? new Date() : null);
  }
}
