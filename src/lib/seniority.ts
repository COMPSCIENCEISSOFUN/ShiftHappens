/**
 * Seniority — how experienced a staff member is, and how the system knows.
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
