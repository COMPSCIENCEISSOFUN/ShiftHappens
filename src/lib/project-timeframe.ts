/** Returns a user-facing validation message when a project timeframe is invalid. */
export function projectTimeframeError(start?: string | null, end?: string | null) {
  if ((start && !end) || (!start && end)) return "A project needs both a start and end date, or neither";
  if (start && end && new Date(end) <= new Date(start)) return "Project end must be after its start";
  return null;
}
