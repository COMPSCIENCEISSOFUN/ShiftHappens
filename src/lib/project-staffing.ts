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
 */
import { prisma } from "@/lib/prisma";

export const PROJECT_TEAM_STAFFING = "project_team";

/** Message used whenever a non-team member is rejected for project work. */
export const OUTSIDE_PROJECT_TEAM_MESSAGE =
  "Staff member is not on the Project Team for this project";

type TeamRestriction = Set<string> | null;

/**
 * Resolves the allowed membership ids for a single project.
 * Returns null when the project does not restrict staffing.
 */
export async function getProjectTeamRestriction(
  projectId: string | null | undefined,
  organizationId: string
): Promise<TeamRestriction> {
  if (!projectId) return null;

  const restrictions = await getProjectTeamRestrictions([projectId], organizationId);
  return restrictions.get(projectId) ?? null;
}

/**
 * Batch form for schedulers that evaluate many project tasks at once.
 * Only projects that restrict staffing appear in the returned map.
 */
export async function getProjectTeamRestrictions(
  projectIds: readonly (string | null | undefined)[],
  organizationId: string
): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
  const restrictions = new Map<string, Set<string>>();
  if (ids.length === 0) return restrictions;

  const projects = await prisma.project.findMany({
    where: {
      id: { in: ids },
      organizationId,
      staffingMode: PROJECT_TEAM_STAFFING,
    },
    select: {
      id: true,
      projectMembers: { select: { membershipId: true } },
    },
  });

  for (const project of projects) {
    restrictions.set(
      project.id,
      new Set(project.projectMembers.map((member) => member.membershipId))
    );
  }

  return restrictions;
}

/** True when the candidate may be considered under the given restriction. */
export function isAllowedByProjectTeam(
  restriction: TeamRestriction,
  membershipId: string
): boolean {
  return restriction === null || restriction.has(membershipId);
}
