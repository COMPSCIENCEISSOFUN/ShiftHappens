/**
 * The two ranking dimensions that had to be computed rather than looked up.
 *
 * Pure functions, deliberately: both were previously inline expressions inside
 * `FallbackRanker` reading a display string and an array length, which is
 * exactly why neither measured what its name claimed. Extracted here they can
 * be tested against real windows and real certificate lists without a database,
 * and reused by the whole-week scheduler, which builds its candidates
 * separately.
 *
 * BCE: `lib` — no database, no framework, callable from Control.
 */
import { dayOfWeekInTimeZone, timeOfDayInTimeZone } from "@/lib/timezone";

export interface AvailabilityWindow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

/** Minutes since midnight for "HH:mm", or null if it is not a time. */
function minutes(value: string): number | null {
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * How tightly a member's declared window wraps a shift, 0–1.
 *
 * 1 means the shift fills their whole window; a member free all week for a
 * four-hour shift lands near 0.17. `null` means the question cannot be
 * answered — no shift time, or a window that does not run forwards — and the
 * ranker treats that as neutral for everybody rather than inventing a number.
 *
 * ## Why tightest fit wins rather than most slack
 *
 * It spends constrained people on the shifts only they can cover and keeps the
 * flexible ones for gaps that appear later — the standard best-fit argument.
 * It also lands the right way round for employment type without a rule saying
 * so: full-time staff default to all seven days open, so they sit below a
 * casual who is free exactly then.
 *
 * ## Why a member with no window scores lowest rather than being excluded
 *
 * A contracted member with no pattern set is rosterable at ANY time — the
 * eligibility layer says so deliberately — which is maximum slack, so the
 * lowest fit is the consistent answer rather than a special case.
 */
export function availabilityFit(
  windows: AvailabilityWindow[],
  shift: { start: Date; end: Date } | null
): number | null {
  if (!shift) return null;

  const shiftMinutes = (shift.end.getTime() - shift.start.getTime()) / 60_000;
  if (shiftMinutes <= 0) return null;

  const day = dayOfWeekInTimeZone(shift.start);
  const window = windows.find((w) => w.dayOfWeek === day && w.isAvailable);

  /*
   * No row for the shift's day means unrestricted, not unavailable — whether
   * they can work it at all was already settled by the eligibility layer, and
   * re-deciding it here would apply a rule this file does not own.
   */
  if (!window) return shiftMinutes / (24 * 60);

  const from = minutes(window.startTime);
  const to = minutes(window.endTime);
  if (from === null || to === null) return null;

  /*
   * A window ending before it starts wraps past midnight — 22:00–06:00 is eight
   * hours, not minus sixteen. The availability check reads it that way, so
   * measuring it any other way here would score a night worker against a
   * negative window and rank them last for the shifts they exist to cover.
   */
  const windowMinutes = to > from ? to - from : 24 * 60 - from + to;
  // Equal times are a window of no length — refused at write time, but a row
  // predating that check could still hold one.
  if (windowMinutes <= 0) return null;

  return Math.min(1, shiftMinutes / windowMinutes);
}

/**
 * The share, 0–1, of a department's certification requirements a member holds.
 *
 * `null` when the department asks for none — a real state, and the honest
 * answer there is that this dimension has no opinion.
 *
 * Compared case-insensitively: certification names are free text typed by
 * whoever uploaded the certificate and by whoever wrote the task, so "First
 * Aid" and "first aid" are the same qualification and treating them as
 * different would silently penalise people.
 */
export function certificationRelevance(
  held: string[],
  departmentRequires: string[]
): number | null {
  const required = [...new Set(departmentRequires.map((c) => c.trim().toLowerCase()))]
    .filter(Boolean);
  if (required.length === 0) return null;

  const owned = new Set(held.map((c) => c.trim().toLowerCase()));
  const matched = required.filter((c) => owned.has(c)).length;
  return matched / required.length;
}

/**
 * The shift's local wall-clock window, for prompts and explanations.
 *
 * Kept beside the scoring so a caller cannot describe a shift in server time
 * while the score was computed in the organisation's.
 */
export function describeShiftWindow(shift: { start: Date; end: Date }): string {
  return `${timeOfDayInTimeZone(shift.start)}–${timeOfDayInTimeZone(shift.end)}`;
}

/**
 * The department-experience score a MANUALLY PINNED seniority is worth.
 *
 * ## The gap this closes
 *
 * Department experience is scored from shifts worked in that department, which
 * is the right measure and is blind in exactly one case: somebody experienced
 * elsewhere. That is precisely the case `seniorityOverride` exists for — the
 * demo data even names them, "an external hire, no local history" — and until
 * now the pin reached the composition rules and stopped there. The engine went
 * on ranking a pinned Senior as a complete novice, because the only thing it
 * counted was a history this organisation had never seen.
 *
 * ## Why a floor rather than a replacement
 *
 * It raises a score, never lowers one. A member pinned "experienced" who has
 * since worked forty shifts here has earned the higher number the count gives
 * them, and a pin set months ago should not pull them back down. Pinning
 * somebody "junior" is likewise not a demotion in the ranking — the level bands
 * describe how much somebody can be trusted with, which composition rules act
 * on, and using them to push a candidate DOWN the list would be a second
 * meaning nobody asked for.
 *
 * ## Where the numbers come from
 *
 * They are the scores the equivalent shift COUNT would produce under the
 * default thresholds: experienced starts at 10 completed shifts, which falls in
 * the 80 band, and senior at 40, which is the 100 band. So a pin puts somebody
 * where their assessed level would have put them if they had earned it here,
 * rather than at an invented number.
 *
 * `null` for no pin and for "junior", both meaning "nothing to add" — a junior
 * pin implies no floor above the 30 that zero history already scores.
 */
export const PINNED_EXPERIENCE_FLOOR: Record<string, number> = {
  experienced: 80,
  senior: 100,
};

export function pinnedExperienceFloor(
  level: string | null | undefined
): number | null {
  if (!level) return null;
  return PINNED_EXPERIENCE_FLOOR[level] ?? null;
}
