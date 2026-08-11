/**
 * How far ahead this product looks.
 *
 * Extracted because four places had already decided it was fourteen days —
 * `recurring-task.service` exported it, `scheduler.service` imported that,
 * and `reporting.service` and `allocation.service` each wrote their own `14`.
 * Three spellings of one number is how they come to disagree, and the leave
 * reminder would have been a fourth.
 *
 * It lives in `lib/` rather than in a service because it is now read by a pure
 * rule (`leave-timing`) that must not import Control.
 */
export const DEFAULT_HORIZON_DAYS = 14;
