/**
 * The three states a review can be in, and what each one means.
 *
 * Pure and client-safe, so the member's own screen and the moderation queue
 * label them the same way. A boolean would not do: "not approved" has to tell
 * "nobody has looked yet" apart from "we looked and said no", because the first
 * is worth waiting for and the second is not.
 */
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Typed as a total map: a new status without a label fails the build. */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "Awaiting review",
  approved: "Published",
  rejected: "Not published",
};

/** What the author is told, in their own words rather than the queue's. */
export const REVIEW_STATUS_NOTE: Record<ReviewStatus, string> = {
  pending: "Thanks — we will take a look before it appears on the site.",
  approved: "This is live on the landing page.",
  rejected: "We have not published this one. You can edit and resubmit.",
};

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return (
    typeof value === "string" &&
    (REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

export const REVIEW_MIN_RATING = 1;
export const REVIEW_MAX_RATING = 5;
export const REVIEW_MAX_LENGTH = 600;
