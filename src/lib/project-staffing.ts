/**
 * Project Team staffing restrictions.
 *
 * A Project using `project_team` staffing keeps a persistent Project Team.
 * Membership narrows WHO may be considered for that project's work items —
 * it never reserves a calendar and never bypasses an eligibility check.
 * Availability, scheduling conflicts, hour limits, certifications, work
 * rules and department scope are still evaluated per Task.
 *
 * `null` means "no restriction" (task_based, or a task with no project).
 * An empty Set is meaningful and different: the team exists but has no
 * members, so no candidate qualifies and allocation returns nothing rather
 * than falling back to the whole organization.
 *
 * Reading the team is `ProjectRepository.findTeamRestriction`. This file is
 * the rule, not the query — nothing under `src/lib` touches the database.
 */

export const PROJECT_TEAM_STAFFING = "project_team";

/** Message used whenever a non-team member is rejected for project work. */
export const OUTSIDE_PROJECT_TEAM_MESSAGE =
  "Staff member is not on the Project Team for this project";

export type TeamRestriction = Set<string> | null;

/** True when the candidate may be considered under the given restriction. */
export function isAllowedByProjectTeam(
  restriction: TeamRestriction,
  membershipId: string
): boolean {
  return restriction === null || restriction.has(membershipId);
}
