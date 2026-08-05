export type ScheduledCalendarItem = {
  scheduledStart: string | Date | null;
  scheduledEnd: string | Date | null;
};

export type CalendarPosition = { top: string; height: string };

function atStartOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

/** True when an item occupies any part of the supplied local calendar day. */
export function intersectsCalendarDay(item: ScheduledCalendarItem, day: Date) {
  if (!item.scheduledStart || !item.scheduledEnd) return false;
  const dayStart = atStartOfDay(day);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return new Date(item.scheduledStart) < dayEnd && new Date(item.scheduledEnd) > dayStart;
}

/**
 * Calculates the visible segment of a task for one calendar day. Segments are
 * clamped to operating hours so overnight or multi-day work never overflows
 * the grid. Null means that day has no visible segment during operating hours.
 */
export function positionForCalendarDay(
  item: ScheduledCalendarItem,
  day: Date,
  operatingHoursStart: number,
  operatingHoursEnd: number
): CalendarPosition | null {
  if (!intersectsCalendarDay(item, day) || operatingHoursEnd <= operatingHoursStart) return null;

  const dayStart = atStartOfDay(day);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const visibleStart = new Date(Math.max(new Date(item.scheduledStart!).getTime(), dayStart.getTime()));
  const visibleEnd = new Date(Math.min(new Date(item.scheduledEnd!).getTime(), dayEnd.getTime()));
  const startHour = (visibleStart.getTime() - dayStart.getTime()) / (60 * 60 * 1000);
  const endHour = (visibleEnd.getTime() - dayStart.getTime()) / (60 * 60 * 1000);
  const clampedStart = Math.max(startHour, operatingHoursStart);
  const clampedEnd = Math.min(endHour, operatingHoursEnd);

  if (clampedEnd <= clampedStart) return null;
  const totalHours = operatingHoursEnd - operatingHoursStart;
  return {
    top: `${((clampedStart - operatingHoursStart) / totalHours) * 100}%`,
    height: `${Math.max(((clampedEnd - clampedStart) / totalHours) * 100, 2)}%`,
  };
}
