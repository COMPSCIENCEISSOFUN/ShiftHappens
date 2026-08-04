/**
 * Seniority — how experienced a staff member is, and how the system knows.
 *
 * ## Why this is not a certification
 *
 * The eligibility engine already answers "is this person allowed to do this?"
 * — certifications, verified by a manager and expiring on a date. It has never
 * been able to answer "has this person done it enough times?", and the two are
 * not the same question: a First Aid certificate issued last Tuesday and one
 * issued in 2019 are indistinguishable to every check in the system.
 *
 * A composition rule like "these two cannot both be junior" is entirely about
 * the second question, so it needs a dimension of its own.
 *
 * ## Why it is derived rather than typed in
 *
 * A manually-maintained seniority column is correct on the day it is set and
 * decays from then on. The platform already records every completed shift, so
 * it can count instead of asking — and a count cannot go stale, cannot be
 * forgotten during a busy month, and is the same number for every member
 * without anyone having to be fair about it.
 *
 * It is counted **per department**. A three-year kitchen veteran is a novice
 * behind the bar, and an org-wide count would confidently say otherwise.
 *
 * ## Why the override exists anyway
 *
 * Derivation has exactly one failure it cannot fix by itself: an experienced
 * hire from another company has completed no shifts *here*. Every count says
 * junior on their first day, and a composition rule would then keep them off
 * the shifts that would prove otherwise — the count is not merely wrong, it is
 * self-confirming. A manager can pin the level; the UI always shows which of
 * the two is in force, because a level that decides who gets rostered should
 * never be an unexplained assertion.
 *
 * ## Why tenure is not part of it
 *
 * Completed shifts already capture tenure and frequency together. Someone
 * employed for two years who works twice a month is not experienced, and any
 * formula including tenure would say they are. One signal is also one
 * sentence to explain to the person it is being applied to.
 */

/**
 * Ordered from least to most experienced. The order is the definition — every
 * comparison in this file is an index lookup — so it must not be reordered for
 * display purposes.
 */
export const SENIORITY_LEVELS = ["junior", "experienced", "senior"] as const;

export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const SENIORITY_LABEL: Record<SeniorityLevel, string> = {
  junior: "Junior",
  experienced: "Experienced",
  senior: "Senior",
};

/** Defaults mirrored in schema.prisma; changing one without the other drifts. */
export const DEFAULT_EXPERIENCED_THRESHOLD = 10;
export const DEFAULT_SENIOR_THRESHOLD = 40;

export interface SeniorityThresholds {
  experiencedShiftThreshold: number;
  seniorShiftThreshold: number;
}

/**
 * A level together with the reason for it.
 *
 * The reason is not decoration. This level can stop someone being rostered, so
 * both the manager and the staff member are shown why — "Experienced — 23
 * completed shifts in Kitchen" rather than a bare badge nobody can argue with.
 */
export interface SeniorityAssessment {
  level: SeniorityLevel;
  /** True when a manager pinned the level and the count was not consulted. */
  overridden: boolean;
  /** Completed shifts counted, regardless of whether an override won. */
  completedShifts: number;
  /** Department the count was scoped to; null means counted org-wide. */
  scopeDepartmentId: string | null;
  explanation: string;
}

export function isSeniorityLevel(value: string): value is SeniorityLevel {
  return (SENIORITY_LEVELS as readonly string[]).includes(value);
}

export function seniorityLabel(value: string | null | undefined): string {
  if (!value) return "Unrated";
  return SENIORITY_LABEL[value as SeniorityLevel] ?? value;
}

/** Position in SENIORITY_LEVELS. Higher is more experienced. */
export function seniorityRank(level: SeniorityLevel): number {
  return SENIORITY_LEVELS.indexOf(level);
}

/**
 * Is `level` at or above `floor`? Used by "at least 1 senior" rules.
 */
export function isAtLeast(level: SeniorityLevel, floor: SeniorityLevel): boolean {
  return seniorityRank(level) >= seniorityRank(floor);
}

/**
 * Is `level` at or below `ceiling`? Used by "at most 1 junior" rules.
 *
 * Deliberately a separate function rather than an inverted `isAtLeast`. The
 * two rule forms read in opposite directions along the scale — "at least
 * Senior" means senior-or-better, "at most Junior" means junior-or-worse — and
 * expressing one as `!isAtLeast(...)` would quietly turn "at most Junior" into
 * "at most Experienced".
 */
export function isAtMost(level: SeniorityLevel, ceiling: SeniorityLevel): boolean {
  return seniorityRank(level) <= seniorityRank(ceiling);
}

/**
 * Thresholds are read from CompanySettings and are user-editable, so they can
 * arrive inverted or at zero however carefully the settings form is written —
 * a direct database edit, an older row, a future endpoint. Rather than trust
 * them, derivation is defined so that any pair produces a sane answer:
 *
 *   - senior is tested first, so if the two are equal or inverted, reaching
 *     the senior threshold wins rather than being masked by the experienced
 *     one;
 *   - a threshold of 0 or below would make every member senior from zero
 *     shifts, which is never what was meant, so it is treated as unreachable.
 */
export function levelFromShiftCount(
  completedShifts: number,
  thresholds: SeniorityThresholds
): SeniorityLevel {
  const senior = thresholds.seniorShiftThreshold;
  const experienced = thresholds.experiencedShiftThreshold;

  if (senior > 0 && completedShifts >= senior) return "senior";
  if (experienced > 0 && completedShifts >= experienced) return "experienced";
  return "junior";
}

function describe(
  level: SeniorityLevel,
  completedShifts: number,
  departmentName: string | null,
  overridden: boolean
): string {
  if (overridden) {
    return `${SENIORITY_LABEL[level]} — set by a manager`;
  }
  const scope = departmentName ? ` in ${departmentName}` : "";
  const shifts = completedShifts === 1 ? "1 completed shift" : `${completedShifts} completed shifts`;
  return `${SENIORITY_LABEL[level]} — ${shifts}${scope}`;
}

/**
 * The level actually in force for a member, and why.
 *
 * `override` is the raw column value, which may hold anything a past version
 * of the app or a direct database edit put there. An unrecognised value is
 * ignored rather than trusted or thrown on: the derived level is always
 * available, so falling back to it keeps rostering working, and a rule
 * silently using a level nobody defined would be worse than one using a
 * slightly stale count.
 */
export function assessSeniority(input: {
  override: string | null | undefined;
  completedShifts: number;
  thresholds: SeniorityThresholds;
  departmentId?: string | null;
  departmentName?: string | null;
}): SeniorityAssessment {
  const scopeDepartmentId = input.departmentId ?? null;
  const overrideValid =
    typeof input.override === "string" && isSeniorityLevel(input.override);

  const level = overrideValid
    ? (input.override as SeniorityLevel)
    : levelFromShiftCount(input.completedShifts, input.thresholds);

  return {
    level,
    overridden: overrideValid,
    completedShifts: input.completedShifts,
    scopeDepartmentId,
    explanation: describe(
      level,
      input.completedShifts,
      input.departmentName ?? null,
      overrideValid
    ),
  };
}
