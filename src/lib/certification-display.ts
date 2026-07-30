/**
 * Certification Display Helpers (shared, client-safe)
 *
 * The certification pages, the staff dashboard and the notification copy all
 * need the same three answers: what state is this certificate really in, how
 * long has it got, and how do we spell the date. Deriving that in each place
 * is how "expiring" ends up meaning 30 days on one screen and 14 on another.
 *
 * Deliberately free of imports beyond `@/lib/timezone` (which imports nothing)
 * so a "use client" page can use it without pulling Prisma or Zod into the
 * browser bundle. `certification.service.ts` re-exports the labels from here
 * rather than keeping a second copy.
 *
 * On the "expired" boundary: a certificate is shown as expired the moment its
 * expiry instant passes, matching `getValidCertifications` — the query that
 * actually decides eligibility. Anything looser would badge a certificate
 * "verified" while the engine had already stopped counting it.
 */
import {
  DEFAULT_TIMEZONE,
  localDateInTimeZone,
  startOfDayInTimeZone,
} from "@/lib/timezone";

/** How far ahead an expiring certification is worth warning about. */
export const EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a certificate looks like to a human. The four stored statuses plus the
 * two states derived from `expiryDate`, which is never stored.
 */
export type CertificationDisplayState =
  | "pending"
  | "verified"
  | "expiring"
  | "expired"
  | "rejected"
  | "revoked";

export interface RejectionReasonOption {
  value: string;
  label: string;
  /** One line telling the reviewer when this reason is the right one. */
  description: string;
}

/**
 * The predefined reasons a reviewer can give, in the order they are offered.
 *
 * `value` must stay in lock-step with `CERTIFICATION_REJECTION_REASONS` in
 * `@/lib/validations` — the API rejects anything else. They are written out
 * here rather than imported so this module stays Zod-free; a test asserts the
 * two lists are identical, which is what actually keeps them honest.
 */
export const REJECTION_REASONS: RejectionReasonOption[] = [
  {
    value: "certificate_expired",
    label: "Certificate expired",
    description: "The document is past its expiry date",
  },
  {
    value: "document_unreadable",
    label: "Document unreadable",
    description: "Cannot verify the details from what was submitted",
  },
  {
    value: "wrong_certification",
    label: "Wrong certification",
    description: "Does not match the certification named",
  },
  {
    value: "details_mismatch",
    label: "Details do not match",
    description: "Name or dates differ from the document",
  },
  {
    value: "not_recognised",
    label: "Not recognised",
    description: "Issuer or qualification is not accepted here",
  },
  {
    value: "other",
    label: "Other",
    description: "Explain in the notes below",
  },
];

/** Human-readable labels for the predefined rejection reasons. */
export const REJECTION_REASON_LABELS: Record<string, string> =
  Object.fromEntries(REJECTION_REASONS.map((r) => [r.value, r.label]));

/** The longest set of notes the API will accept alongside a reason. */
export const REJECTION_NOTES_MAX = 500;

/**
 * Derives the state to show for a certificate.
 *
 * Only a verified certificate can be expiring or expired — a pending or
 * rejected submission with a lapsed date is still pending or rejected, because
 * that is the thing the reader has to act on.
 *
 * `now` is injectable so tests can pin it instead of racing the clock.
 */
export function certificationDisplayState(
  status: string,
  expiryDate: string | Date | null | undefined,
  now: Date = new Date()
): CertificationDisplayState {
  // An unrecognised status passes straight through rather than being
  // relabelled: showing it verbatim is a visible bug, quietly calling it
  // "pending" is an invisible one.
  if (status !== "verified") return status as CertificationDisplayState;

  if (!expiryDate) return "verified";

  const expiry = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return "verified";

  if (expiry.getTime() <= now.getTime()) return "expired";

  // The warning window is measured from the organisation's midnight, so the
  // set of "expiring" certificates does not shift as the day progresses.
  const warnUntil =
    startOfDayInTimeZone(now).getTime() + EXPIRY_WARNING_DAYS * DAY_MS;

  return expiry.getTime() <= warnUntil ? "expiring" : "verified";
}

/**
 * Whole calendar days from today until a certificate lapses, in organisation
 * time. Negative once it has lapsed, 0 on the day itself.
 *
 * Counted between local midnights rather than by dividing a raw difference, so
 * "expires in 22 days" means 22 sleeps and not 21.4 rounded down.
 */
export function daysUntilExpiry(
  expiryDate: string | Date,
  now: Date = new Date()
): number {
  const expiry = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return 0;

  const from = startOfDayInTimeZone(now).getTime();
  const to = startOfDayInTimeZone(expiry).getTime();
  return Math.round((to - from) / DAY_MS);
}

/**
 * Uniform three-letter month names.
 *
 * Not taken from Intl: `toLocaleDateString("en-GB", { month: "short" })` renders
 * September as "Sept" and every other month with three letters, so a list of
 * dates came out visibly ragged. Locale data is also free to change between
 * Node and ICU versions, which is not something a stored calendar date's
 * rendering should depend on.
 */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Formats a certificate date as "12 Jun 2026".
 *
 * Pinned to the organisation timezone: issue and expiry are calendar dates, and
 * formatting them in the server's zone (UTC on Vercel) would show the previous
 * day for anything stored at local midnight. The date parts come from
 * `localDateInTimeZone`, which is already covered by the timezone tests.
 */
export function formatCertDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const [year, month, day] = localDateInTimeZone(date, DEFAULT_TIMEZONE)
    .split("-")
    .map(Number);

  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * Converts an `<input type="date">` value ("2026-06-12") to the ISO instant the
 * API expects (`z.string().datetime()`).
 *
 * The naive `new Date("2026-06-12").toISOString()` stores UTC midnight, which is
 * 08:00 on the 12th in Singapore — so a certificate typed as expiring on the
 * 12th stops counting part-way through the 11th's evening for anyone reasoning
 * in local days. Anchoring to the ORGANISATION's midnight instead means the date
 * read back by `formatCertDate` is always the date that was typed.
 *
 * Noon UTC is used as the probe instant purely because it falls inside the same
 * calendar day for every real-world offset, so the snap to local midnight lands
 * on the intended day without hardcoding "+08:00" here.
 *
 * Returns null for a blank or unparseable value, so a caller can omit the field
 * rather than sending "Invalid Date".
 */
export function dateInputToIso(value: string): string | null {
  if (!value) return null;
  const probe = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(probe.getTime())) return null;
  return startOfDayInTimeZone(probe).toISOString();
}

/**
 * The inverse: an instant to a "YYYY-MM-DD" value for a date input, in
 * organisation time. Used to prefill a renewal from the certificate it replaces.
 */
export function isoToDateInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return localDateInTimeZone(date);
}

/** "2 days ago" / "just now" for submission times. */
export function relativeTime(
  value: string | Date,
  now: Date = new Date()
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatCertDate(date);
}
