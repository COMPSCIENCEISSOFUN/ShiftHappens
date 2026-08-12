/**
 * Project data access (Entity layer).
 *
 * Projects arrived with their service talking to Prisma directly and no
 * repository at all, which left the one feature in the codebase that could not
 * be traced Boundary -> Control -> Entity. Every query the feature makes lives
 * here now; `ProjectService` keeps the rules and owns none of the SQL.
 *
 * The team restriction started life in `src/lib/project-staffing`, which meant
 * a file under `src/lib` opened a Prisma client. Nothing under `src/lib` may
 * reach the database — that boundary is what makes the layering checkable by
 * grep rather than by reading every file — so the query lives here and the rule
 * that interprets its result stays pure.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { PROJECT_TEAM_STAFFING, type TeamRestriction } from "@/lib/project-staffing";

/** Fields a caller may set when creating a project. */
export interface CreateProjectData {
  organizationId: string;
  /** At least one; the first is kept on `departmentId` for scope queries. */
  departmentIds: string[];
  title: string;
  description?: string | null;
  priority: string;
  staffingMode: string;
  plannedStart?: Date;
  plannedEnd?: Date;
  createdById: string;
}

/**
 * Fields a caller may change.
 *
 * `undefined` leaves a field alone and `null` clears it — the same distinction
 * the rest of the codebase relies on, and the reason these are not collapsed
 * into optional-only types.
 */
export interface UpdateProjectData {
  title?: string;
  description?: string | null;
  departmentId?: string | null;
  priority?: string;
  staffingMode?: string;
  status?: string;
  plannedStart?: Date | null;
  plannedEnd?: Date | null;
}

export class ProjectRepository {
  /**
   * The full shape a project is read in.
   *
   * One definition rather than one per method: the detail page, the list and
   * the post-write reads all render the same object, and a select that drifts
   * between them is how a field comes to be present on one screen and missing
   * on another.
   */
  private include = {
    createdBy: {
      select: { id: true, name: true, email: true },
    },

    department: {
      select: { id: true, name: true, color: true },
    },

    projectDepartments: {
      include: {
        department: { select: { id: true, name: true, color: true } },
      },
      orderBy: { department: { name: "asc" as const } },
    },

    projectMembers: {
      orderBy: { createdAt: "asc" as const },
      include: {
        membership: {
          select: {
            id: true,
            role: true,
            status: true,
            employmentType: true,
            user: { select: { id: true, name: true, email: true, image: true } },
            departmentMemberships: {
              include: {
                department: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    },

    tasks: {
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        scheduledStart: true,
        scheduledEnd: true,
        requiredHeadcount: true,
        requiredCertifications: true,
        // Selected as well as sorted on: the reorder controls need to know
        // what the current position is to write the swapped one back.
        orderIndex: true,
        assignments: {
          select: {
            id: true,
            membershipId: true,
            status: true,
            membership: {
              select: {
                id: true,
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
      /*
       * Running order first, then the original schedule/creation ordering as
       * the tiebreak. Every existing row has orderIndex 0, so a project nobody
       * has reordered reads exactly as it did before this column existed.
       */
      orderBy: [
        { orderIndex: "asc" as const },
        { scheduledStart: "asc" as const },
        { createdAt: "asc" as const },
      ],
    },
  } satisfies Prisma.ProjectInclude;

  async create(data: CreateProjectData) {
    return prisma.project.create({
      data: {
        organizationId: data.organizationId,
        departmentId: data.departmentIds[0],
        projectDepartments: {
          create: data.departmentIds.map((departmentId) => ({ departmentId })),
        },
        title: data.title,
        description: data.description ?? undefined,
        priority: data.priority,
        staffingMode: data.staffingMode,
        plannedStart: data.plannedStart,
        plannedEnd: data.plannedEnd,
        createdById: data.createdById,
      },
      include: this.include,
    });
  }

  /**
   * Every project in the organisation, narrowed to a department scope.
   *
   * `null` and `undefined` both mean an unrestricted scope. An empty array does
   * not: a manager assigned to no departments is scoped to nothing. Projects
   * with no department of their own stay visible either way — they belong to
   * the organisation rather than to one team.
   */
  async findByOrganizationId(
    organizationId: string,
    departmentScope?: string[] | null
  ) {
    return prisma.project.findMany({
      where: {
        organizationId,
        ...(departmentScope === null || departmentScope === undefined
          ? {}
          : {
              OR: [
                { departmentId: { in: departmentScope } },
                { departmentId: null },
              ],
            }),
      },
      include: this.include,
      orderBy: [{ plannedStart: "asc" }, { createdAt: "desc" }],
    });
  }

  async findById(projectId: string, organizationId: string) {
    return prisma.project.findFirst({
      where: { id: projectId, organizationId },
      include: this.include,
    });
  }

  /**
   * The parent of a work item: the fields a Task needs in order to inherit from
   * its project, and to be refused when it falls outside it.
   */
  async findForWorkItem(projectId: string, organizationId: string) {
    return prisma.project.findFirst({
      where: { id: projectId, organizationId },
      select: {
        departmentId: true,
        priority: true,
        status: true,
        plannedStart: true,
        plannedEnd: true,
      },
    });
  }

  /**
   * Applies an update, optionally dropping the persistent team in the same
   * transaction.
   *
   * The two are one write because leaving Project Team staffing is what drops
   * the team: an update that succeeded while the delete failed would leave a
   * task_based project holding a team that nothing displays and nothing clears.
   */
  async update(projectId: string, data: UpdateProjectData, clearsTeam: boolean) {
    return prisma.$transaction(async (tx) => {
      if (clearsTeam) {
        await tx.projectMember.deleteMany({ where: { projectId } });
      }
      return tx.project.update({
        where: { id: projectId },
        data,
        include: this.include,
      });
    });
  }

  /**
   * Replaces the whole team.
   *
   * Serializable because delete-then-insert is only correct if no other writer
   * interleaves: two managers saving different teams at once would otherwise
   * merge into a team neither of them chose.
   */
  async replaceTeam(projectId: string, membershipIds: string[]) {
    await prisma.$transaction(
      async (tx) => {
        await tx.projectMember.deleteMany({ where: { projectId } });
        if (membershipIds.length > 0) {
          await tx.projectMember.createMany({
            data: membershipIds.map((membershipId) => ({ projectId, membershipId })),
          });
        }
      },
      { isolationLevel: "Serializable" }
    );
  }

  /**
   * Allowed membership ids for a single project, or null when the project
   * places no restriction on who may be considered.
   */
  async findTeamRestriction(
    projectId: string | null | undefined,
    organizationId: string
  ): Promise<TeamRestriction> {
    if (!projectId) return null;
    const restrictions = await this.findTeamRestrictions([projectId], organizationId);
    return restrictions.get(projectId) ?? null;
  }

  /**
   * Batch form for schedulers that evaluate many project tasks at once.
   * Only projects that restrict staffing appear in the returned map, so a
   * missing key and an empty Set mean different things: no restriction, and a
   * team with nobody on it.
   */
  async findTeamRestrictions(
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
}
