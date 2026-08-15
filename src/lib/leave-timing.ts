/**
 * When an unanswered leave request stops being fine and starts being a problem.
 *
 */
import { DEFAULT_HORIZON_DAYS } from "@/lib/scheduling-horizon";

/**
 * How long a reviewer has before they are chased.
 *
 * 48 hours is the low end of the 48–72h service level HR tooling converges on.
 * The low end, because this is shift work: the thing waiting on the answer is a
 * roster, not a spreadsheet.
 */
export const LEAVE_SLA_HOURS = 48;

/** How long after the first chase before it goes above them. */
export const LEAVE_ESCALATION_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export interface ChaseRow {
  /** The day being asked off. */
  date: Date;
  /** When the review clock last started. Null on rows written before it existed. */
  submittedAt: Date | null;
  remindedAt: Date | null;
  escalatedAt: Date | null;
}

/**
 * The two instants the rule turns on.
 *
 * A request is "closing soon" if it was submitted before `slaBefore` OR its date
 * falls before `dateBefore`. Both are plain comparisons, which is what lets the
 * same rule be a predicate here and a `WHERE` clause in the repository.
 */
export function chaseBoundaries(
  now: Date = new Date(),
  horizonDays: number = DEFAULT_HORIZON_DAYS
) {
  return {
    slaBefore: new Date(now.getTime() - LEAVE_SLA_HOURS * HOUR_MS),
    dateBefore: new Date(now.getTime() + horizonDays * 24 * HOUR_MS),
  };
}

/**
 * Whether this request is running out of time.
 *
 * Says nothing about whether anybody has been told — that is `chaseStageFor`.
 * Kept separate because the SCREEN wants the first question and the JOB wants
 * the second, and collapsing them would mean a request stopped being labelled
 * urgent the moment a reminder went out, which is exactly backwards.
 */
export function isClosingSoon(
  row: Pick<ChaseRow, "date" | "submittedAt">,
  now: Date = new Date(),
  horizonDays: number = DEFAULT_HORIZON_DAYS
): boolean {
  const { slaBefore, dateBefore } = chaseBoundaries(now, horizonDays);
  // A row predating the column has no clock; the date half still applies.
  const overdue = row.submittedAt !== null && row.submittedAt < slaBefore;
  return overdue || row.date < dateBefore;
}

export type ChaseStage = "none" | "remind" | "escalate";

/**
 * What the sweep should do about this request, if anything.
 *
 * Terminal by construction: once `escalatedAt` is set there is no further
 * stage, so a request that nobody ever answers is chased exactly twice. A rule
 * that re-sent on a cooldown would train every manager in the organisation to
 * filter the sender.
 */
export function chaseStageFor(
  row: ChaseRow,
  now: Date = new Date(),
  horizonDays: number = DEFAULT_HORIZON_DAYS
): ChaseStage {
  if (!isClosingSoon(row, now, horizonDays)) return "none";
  if (row.escalatedAt) return "none";
  if (!row.remindedAt) return "remind";

  const due = row.remindedAt.getTime() + LEAVE_ESCALATION_HOURS * HOUR_MS;
  return now.getTime() >= due ? "escalate" : "none";
}
