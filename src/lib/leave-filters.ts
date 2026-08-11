/**
 * The vocabulary the leave register is filtered by.
 *
 * Client-safe on purpose: the page renders these options and the service
 * translates them into a query, so the words on the screen and the words the
 * server accepts are one list. Restating them as string literals in the page
 * is how a filter comes to send `"declined"` to an endpoint that only knows
 * `"rejected"` — which is precisely the trap here, because the UI has always
 * said "Declined" and the column has always stored `"rejected"`.
 *
 * ## Why "awaiting" and "lapsed" are separate views of one status
 *
 * Neither is a value in the database. Both are `status: "pending"`; what
 * separates them is whether the date has gone by. The split lives here rather
 * than in the column because it is not a fact about the row — it changes at
 * midnight, without anybody writing anything.
 *
 * ## Why "approved" is not simply `status = "approved"`
 *
 * A CASUAL member's override is written `approved` the moment they save it,
 * because their availability is an offer that binds at once. Those are not
 * leave requests and nobody ever decided them; listing them in a register of
 * decisions would bury the real ones under everyone's ordinary availability
 * edits. The register asks a different question — did this row ever go through
 * review — and answers it with `reviewedById`, which is set only when somebody
 * acted. That is the same field `deleteOverride` tests, and for the same
 * reason: it is the fact that a decision was made, where the status is only
 * what the row currently says.
 */

export const LEAVE_VIEWS = [
  "awaiting",
  "lapsed",
  "pending",
  "approved",
  "declined",
  "dismissed",
  "all",
] as const;

export type LeaveView = (typeof LEAVE_VIEWS)[number];

/** The view the page opens on — the one that is somebody's work. */
export const DEFAULT_LEAVE_VIEW: LeaveView = "awaiting";

export const LEAVE_VIEW_LABEL: Record<LeaveView, string> = {
  awaiting: "Awaiting decision",
  lapsed: "Lapsed",
  pending: "Undecided",
  approved: "Approved",
  declined: "Declined",
  dismissed: "Dismissed",
  all: "All",
};

/**
 * A one-line explanation per view, shown when a filtered list comes back empty.
 *
 * "No results" is true of a filter nobody has ever used and of one that has
 * just been narrowed too far, and those need different next moves from the
 * reader.
 */
export const LEAVE_VIEW_EMPTY: Record<LeaveView, string> = {
  awaiting: "Nothing is waiting on a decision.",
  lapsed: "No requests have gone past their date unanswered.",
  pending: "Nothing is undecided.",
  approved: "No leave has been approved yet.",
  declined: "No requests have been declined.",
  dismissed: "Nothing has been dismissed.",
  all: "Nobody has requested leave yet.",
};

export function isLeaveView(value: unknown): value is LeaveView {
  return (
    typeof value === "string" && (LEAVE_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Which way the list reads.
 *
 * The two live views are work: the nearest date is the most urgent, so soonest
 * first. Everything else is a record, and a record is read newest first. One
 * rule in one place, rather than an `order` parameter for every caller to get
 * right — and it is the SERVICE that decides, so the page cannot ask for an
 * ordering the register does not have an argument for.
 */
export function leaveOrderFor(view: LeaveView): "asc" | "desc" {
  return view === "awaiting" || view === "lapsed" || view === "pending"
    ? "asc"
    : "desc";
}

/**
 * The four figures shown above the list, in the order they are shown.
 *
 * Two open states and two decided ones. `dismissed` is deliberately absent — a
 * tile is a thing to act on or a thing to know, and "how many lapsed requests
 * somebody has tidied away" is neither; it is reachable as a filter for anyone
 * who wants it.
 */
export const LEAVE_TILE_VIEWS = [
  "awaiting",
  "lapsed",
  "approved",
  "declined",
] as const satisfies readonly LeaveView[];

/** The most rows one request will return. See `getLeaveRegister`. */
export const LEAVE_PAGE_SIZE = 50;
