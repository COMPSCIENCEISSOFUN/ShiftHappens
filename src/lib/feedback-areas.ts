/**
 * The areas a member may file feedback against.
 *
 * A closed list, chosen by the sender rather than inferred. Counting these is
 * SQL's job — an exact answer, free, and available the moment the first message
 * arrives, with no model involved and nothing to be wrong about.
 *
 * Stored as the id, displayed through `FEEDBACK_AREA_LABEL`. The ids are part
 * of the data once a row exists, so renaming one is a migration, not an edit.
 */
export const FEEDBACK_AREAS = [
  "scheduling",
  "availability",
  "members",
  "billing",
  "notifications",
  "other",
] as const;

export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/**
 * Typed as a total map on purpose: adding an id above without a label here
 * fails the build rather than rendering a blank chip nobody notices.
 */
export const FEEDBACK_AREA_LABEL: Record<FeedbackArea, string> = {
  scheduling: "Scheduling & shifts",
  availability: "Availability & leave",
  members: "Members & permissions",
  billing: "Billing & plans",
  notifications: "Notifications & email",
  other: "Something else",
};

export function isFeedbackArea(value: unknown): value is FeedbackArea {
  return (
    typeof value === "string" &&
    (FEEDBACK_AREAS as readonly string[]).includes(value)
  );
}

/**
 * The longest message the form accepts.
 *
 * Long enough for a considered paragraph, short enough that one sender cannot
 * fill the queue with a single submission.
 */
export const FEEDBACK_MAX_LENGTH = 2000;
