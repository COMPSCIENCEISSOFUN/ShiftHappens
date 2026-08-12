/**
 * Customer reviews (Control layer).
 *
 * ## Publishing is never automatic
 *
 * Nothing a member writes reaches the landing page without a platform admin
 * approving it, and an edit withdraws that approval. The unique key means a
 * member has exactly one review, so an edit changes the row that is live —
 * without the reset, somebody could be approved for one paragraph and then
 * quietly replace it with another.
 */
import {
  REVIEW_MAX_LENGTH,
  REVIEW_MAX_RATING,
  REVIEW_MIN_RATING,
  isReviewStatus,
} from "@/lib/review-status";
import { MembershipRepository } from "@/repositories/membership.repository";
import { ReviewRepository } from "@/repositories/review.repository";

/** How many appear on the landing page. */
export const REVIEWS_ON_LANDING = 12;

export const REVIEW_PAGE_SIZE = 25;

export interface SubmitReviewInput {
  rating: number;
  body: string;
}

export class ReviewService {
  private reviewRepo = new ReviewRepository();
  private membershipRepo = new MembershipRepository();

  /**
   * Write or rewrite this member's review.
   *
   * The membership is resolved rather than trusted, as everywhere else here:
   * the landing page prints the organisation beside the words.
   */
  async submit(userId: string, organizationId: string, input: SubmitReviewInput) {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < REVIEW_MIN_RATING ||
      input.rating > REVIEW_MAX_RATING
    ) {
      throw new Error(
        `Choose a rating between ${REVIEW_MIN_RATING} and ${REVIEW_MAX_RATING}`
      );
    }

    const body = input.body.trim();
    if (body.length === 0) throw new Error("Please write a few words");
    if (body.length > REVIEW_MAX_LENGTH) {
      throw new Error(`A review must be ${REVIEW_MAX_LENGTH} characters or fewer`);
    }

    const membership = await this.membershipRepo.findByUserAndOrg(
      userId,
      organizationId
    );
    if (!membership) {
      throw new Error("You are not a member of this organization");
    }

    return this.reviewRepo.upsert({
      membershipId: membership.id,
      organizationId,
      rating: input.rating,
      body,
    });
  }

  /** This member's own review, or null if they have not written one. */
  async getMine(userId: string, organizationId: string) {
    const membership = await this.membershipRepo.findByUserAndOrg(
      userId,
      organizationId
    );
    if (!membership) return null;
    return this.reviewRepo.findByMembership(membership.id);
  }

  /** What the landing page renders. Approved only, newest first. */
  async getPublished() {
    return this.reviewRepo.findApproved(REVIEWS_ON_LANDING);
  }

  /** The moderation queue. Defaults to what is waiting. */
  async getQueue(status: string | undefined = "pending", requestedPage = 0) {
    const filter = isReviewStatus(status) ? status : undefined;

    const total = await this.reviewRepo.countByStatus(filter);
    const lastPage = Math.max(0, Math.ceil(total / REVIEW_PAGE_SIZE) - 1);
    const page = Math.min(Math.max(0, Math.floor(requestedPage) || 0), lastPage);

    const [rows, counts] = await Promise.all([
      this.reviewRepo.findByStatus(filter, REVIEW_PAGE_SIZE, page * REVIEW_PAGE_SIZE),
      this.reviewRepo.countsByStatus(),
    ]);

    return { rows, total, page, pageSize: REVIEW_PAGE_SIZE, counts };
  }

  async setStatus(reviewId: string, status: string) {
    if (!isReviewStatus(status) || status === "pending") {
      // Back to pending is not a decision anybody makes: an edit does that, and
      // offering it here would let a moderator undo their own approval in a way
      // the author cannot see or explain.
      throw new Error("A review can only be approved or rejected");
    }
    const existing = await this.reviewRepo.findById(reviewId);
    if (!existing) throw new Error("Review not found");
    return this.reviewRepo.setStatus(reviewId, status);
  }
}
