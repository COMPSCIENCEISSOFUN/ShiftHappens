/**
 * The reasons a staff member can give for not working a shift.
 *
 * Used in two places that are the same question at different moments:
 *
 *   - REJECTING an offered assignment ("I can't take this")
 *   - WITHDRAWING from one already accepted ("I can no longer do this")
 *
 * ## Why this file exists
 *
 * The same eight values were written out in three places — the Zod enum in
 * `validations.ts`, a hard-coded `<option>` list in the My Tasks page, and a
 * label map in `pdf-report.service.ts`. Nothing kept them in step. Adding a
 * reason to the enum would not have offered it in the dropdown; removing one
 * would have left the dropdown offering a value the API rejects with a 400,
 * and the staff member would have seen "Validation failed" with no way to
 * proceed.
 *
 * Everything now derives from `DECLINE_REASONS`. The two label maps are typed
 * as `Record<DeclineReason, string>`, so adding a value here fails the build
 * until both are updated — the drift is caught by the compiler rather than by
 * a user.
 *
 * ## Why two sets of labels
 *
 * They are not stylistic variants of each other. `REASON_LABEL` is a UI label
 * that stands alone in a dropdown, so it is capitalised. `REASON_PHRASE` is
 * dropped into running prose in a generated report ("…mostly due to schedule
 * conflicts"), so it is lower case and plural. Sharing one map would make one
 * of the two read wrongly.
 */

/**
 * Canonical order, which is also the order shown in the dropdown. `other` is
 * deliberately last: a list that opens with an escape hatch invites people to
 * take it, and an "other" rejection tells a manager nothing they can act on.
 */
export const DECLINE_REASONS = [
  "schedule_conflict",
  "feeling_unwell",
  "exceeds_preferred_hours",
  "transport_issues",
  "insufficient_notice",
  "rest_period_needed",
  "personal_reasons",
  "other",
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Standalone UI label, e.g. in a `<select>`. */
export const REASON_LABEL: Record<DeclineReason, string> = {
  schedule_conflict: "Schedule conflict",
  feeling_unwell: "Feeling unwell",
  exceeds_preferred_hours: "Exceeds preferred hours",
  transport_issues: "Transport issues",
  insufficient_notice: "Insufficient notice",
  rest_period_needed: "Rest period needed",
  personal_reasons: "Personal reasons",
  other: "Other",
};

/**
 * Lower-case plural form for use inside a sentence, e.g.
 * "declined mostly due to schedule conflicts".
 */
export const REASON_PHRASE: Record<DeclineReason, string> = {
  schedule_conflict: "schedule conflicts",
  feeling_unwell: "feeling unwell",
  exceeds_preferred_hours: "exceeds preferred hours",
  transport_issues: "transport issues",
  insufficient_notice: "insufficient notice",
  rest_period_needed: "rest period needed",
  personal_reasons: "personal reasons",
  other: "other reasons",
};

/**
 * A stored reason as a human label, tolerant of anything unrecognised.
 *
 * The column is a plain string, so historic rows may hold values that predate
 * this list — including the free text withdrawals accepted before withdrawal
 * reasons became structured. Those are shown as they were written rather than
 * hidden or relabelled, because they are still what the person said.
 */
export function reasonLabel(value: string | null | undefined): string {
  if (!value) return "No reason given";
  if (isDeclineReason(value)) return REASON_LABEL[value];

  // Free text from before the change, or a value from a newer client. Shown
  // verbatim; underscores are converted in case it is an unrecognised enum-like
  // key rather than a sentence.
  return value.includes(" ") ? value : value.replace(/_/g, " ");
}

export function isDeclineReason(value: string): value is DeclineReason {
  return (DECLINE_REASONS as readonly string[]).includes(value);
}
