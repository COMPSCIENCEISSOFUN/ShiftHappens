import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { projectTimeframeError } from "@/lib/project-timeframe";
import {
  AuditLogService,
  ACTIONS,
} from "@/services/audit-log.service";

import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "@/lib/validations";

export class ProjectService {
  private auditService = new AuditLogService();

  private include = {
    department: {
      select: {
        id: true,
        name: true,
        color: true,
      },
    },

    projectMembers: {
      orderBy: {
        createdAt: "asc" as const,
      },

      include: {
        membership: {
          select: {
            id: true,
            role: true,
            status: true,
            employmentType: true,

            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },

            departmentMemberships: {
              include: {
                department: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
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
        location: true,
        instructions: true,

        status: true,
        priority: true,

        scheduledStart: true,
        scheduledEnd: true,

        requiredHeadcount: true,
        requiredCertifications: true,

        assignments: {
          select: {
            id: true,
            membershipId: true,
            status: true,

            membership: {
              select: {
                id: true,

                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },

      orderBy: [
        {
          scheduledStart: "asc" as const,
        },
        {
          createdAt: "asc" as const,
        },
      ],
    },
  } satisfies Prisma.ProjectInclude;

  async create(
    input: CreateProjectInput,
    organizationId: string,
    userId: string
  ) {
    this.validateDates(
      input.plannedStart,
      input.plannedEnd
    );

    await this.assertDepartment(
      input.departmentId,
      organizationId
    );

    const project =
      await prisma.project.create({
        data: {
          organizationId,

          departmentId:
            input.departmentId,

          title: input.title,

          description:
            input.description,

          priority:
            input.priority ?? "medium",

          staffingMode:
            input.staffingMode ??
            "task_based",

          plannedStart:
            input.plannedStart
              ? new Date(
                  input.plannedStart
                )
              : undefined,

          plannedEnd:
            input.plannedEnd
              ? new Date(
                  input.plannedEnd
                )
              : undefined,

          createdById: userId,
        },

        include: this.include,
      });

    await this.auditService.log({
      organizationId,
      userId,

      action:
        ACTIONS.PROJECT_CREATED,

      entityType: "project",
      entityId: project.id,

      details: {
        title: project.title,
        departmentId:
          project.departmentId,
        staffingMode:
          project.staffingMode,
      },
    });

    return project;
  }

  async list(
    organizationId: string,
    departmentScope?:
      | string[]
      | null
  ) {
    return prisma.project.findMany({
      where: {
        organizationId,

        ...(departmentScope === null ||
        departmentScope === undefined
          ? {}
          : {
              departmentId: {
                in: departmentScope,
              },
            }),
      },

      include: this.include,

      orderBy: [
        {
          plannedStart: "asc",
        },
        {
          createdAt: "desc",
        },
      ],
    });
  }

  async get(
    projectId: string,
    organizationId: string
  ) {
    return prisma.project.findFirst({
      where: {
        id: projectId,
        organizationId,
      },

      include: this.include,
    });
  }

  async update(
    projectId: string,
    organizationId: string,
    input: UpdateProjectInput,
    userId: string
  ) {
    const existing =
      await this.get(
        projectId,
        organizationId
      );

    if (!existing) {
      throw new Error(
        "Project not found"
      );
    }

    await this.assertDepartment(
      input.departmentId,
      organizationId
    );

    /*
     * Once project work or a Project Team
     * exists, moving the entire Project to
     * another department would leave those
     * Tasks and members under the original
     * department.
     */
    if (
      input.departmentId !==
        undefined &&
      input.departmentId !==
        existing.departmentId &&
      (existing.tasks.length > 0 ||
        existing.projectMembers
          .length > 0)
    ) {
      throw new Error(
        existing.tasks.length > 0
          ? "Cannot change the project department after work items have been created"
          : "Cannot change the project department while the Project Team has members"
      );
    }

    const plannedStart =
      input.plannedStart === ""
        ? null
        : input.plannedStart ??
          existing.plannedStart?.toISOString();

    const plannedEnd =
      input.plannedEnd === ""
        ? null
        : input.plannedEnd ??
          existing.plannedEnd?.toISOString();

    this.validateDates(
      plannedStart ?? undefined,
      plannedEnd ?? undefined
    );

    /*
     * If the Project timeframe changes,
     * existing work items must still fit.
     */
    if (
      input.plannedStart !==
        undefined ||
      input.plannedEnd !== undefined
    ) {
      const newStart =
        plannedStart
          ? new Date(plannedStart)
          : null;

      const newEnd =
        plannedEnd
          ? new Date(plannedEnd)
          : null;

      const outside =
        existing.tasks.find(
          (task) => {
            if (
              !task.scheduledStart ||
              !task.scheduledEnd
            ) {
              return false;
            }

            if (
              newStart &&
              task.scheduledStart <
                newStart
            ) {
              return true;
            }

            if (
              newEnd &&
              task.scheduledEnd >
                newEnd
            ) {
              return true;
            }

            return false;
          }
        );

      if (outside) {
        throw new Error(
          `Cannot change project timeframe because "${outside.title}" would fall outside it`
        );
      }
    }

    /*
     * A closed Project cannot retain
     * unfinished work.
     */
    if (
      input.status === "completed" ||
      input.status === "cancelled"
    ) {
      const unfinished =
        existing.tasks.filter(
          (task) =>
            task.status !==
              "completed" &&
            task.status !==
              "cancelled"
        );

      if (unfinished.length > 0) {
        const verb =
          input.status ===
          "completed"
            ? "complete"
            : "cancel";

        throw new Error(
          `Cannot ${verb} project while ${unfinished.length} work item(s) are still open`
        );
      }
    }

    /*
     * Leaving Project Team staffing drops the
     * persistent team. Existing Task assignments
     * are untouched — those are real scheduled
     * work. Keeping the membership rows would
     * silently restore the old team if the mode
     * were switched back later.
     */
    const clearsTeam =
      input.staffingMode ===
        "task_based" &&
      existing.staffingMode ===
        "project_team";

    const project =
      await prisma.$transaction(
        async (tx) => {
          if (clearsTeam) {
            await tx.projectMember.deleteMany(
              {
                where: {
                  projectId,
                },
              }
            );
          }

          return tx.project.update({
            where: {
              id: projectId,
            },

            data: {
              title: input.title,

              description:
                input.description,

              departmentId:
                input.departmentId,

              priority:
                input.priority,

              staffingMode:
                input.staffingMode,

              status: input.status,

              plannedStart:
                plannedStart
                  ? new Date(
                      plannedStart
                    )
                  : plannedStart ===
                      null
                    ? null
                    : undefined,

              plannedEnd:
                plannedEnd
                  ? new Date(
                      plannedEnd
                    )
                  : plannedEnd === null
                    ? null
                    : undefined,
            },

            include: this.include,
          });
        }
      );

    await this.auditService.log({
      organizationId,
      userId,

      action:
        ACTIONS.PROJECT_UPDATED,

      entityType: "project",
      entityId: project.id,

      details: {
        title: project.title,
        status: project.status,
        staffingMode:
          project.staffingMode,
      },
    });

    return project;
  }

  /**
   * Replace the complete Project Team.
   *
   * Membership of a Project Team does NOT
   * reserve the worker's calendar.
   *
   * Actual availability/conflict checking
   * still occurs when a concrete Task is
   * assigned.
   */
  async setTeam(
    projectId: string,
    organizationId: string,
    membershipIds: string[],
    userId: string
  ) {
    const project =
      await this.get(
        projectId,
        organizationId
      );

    if (!project) {
      throw new Error(
        "Project not found"
      );
    }

    if (
      project.staffingMode !==
      "project_team"
    ) {
      throw new Error(
        "Project Team is only available when the project uses Project Team staffing"
      );
    }

    if (
      project.status ===
        "completed" ||
      project.status ===
        "cancelled"
    ) {
      throw new Error(
        "A completed or cancelled project cannot change its team"
      );
    }

    const uniqueMembershipIds = [
      ...new Set(membershipIds),
    ];

    if (
      uniqueMembershipIds.length > 0
    ) {
      /*
       * Only ACTIVE Staff Members from
       * the same organization are valid.
       *
       * If the Project belongs to one
       * department, team members must
       * also belong to that department.
       */
      const validMembers =
        await prisma.membership.findMany({
          where: {
            id: {
              in: uniqueMembershipIds,
            },

            organizationId,

            role: "staff",
            status: "active",

            ...(project.departmentId
              ? {
                  departmentMemberships:
                    {
                      some: {
                        departmentId:
                          project.departmentId,
                      },
                    },
                }
              : {}),
          },

          select: {
            id: true,
          },
        });

      if (
        validMembers.length !==
        uniqueMembershipIds.length
      ) {
        throw new Error(
          "One or more selected team members are invalid, inactive, outside the organization, or outside the project department"
        );
      }
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.projectMember.deleteMany({
          where: {
            projectId,
          },
        });

        if (
          uniqueMembershipIds.length >
          0
        ) {
          await tx.projectMember.createMany({
            data:
              uniqueMembershipIds.map(
                (membershipId) => ({
                  projectId,
                  membershipId,
                })
              ),
          });
        }
      },
      {
        isolationLevel:
          "Serializable",
      }
    );

    await this.auditService.log({
      organizationId,
      userId,

      action:
        ACTIONS.PROJECT_UPDATED,

      entityType: "project",
      entityId: projectId,

      details: {
        action:
          "project_team_updated",

        membershipIds:
          uniqueMembershipIds,
      },
    });

    return this.get(
      projectId,
      organizationId
    );
  }

  private validateDates(
    start?: string,
    end?: string
  ) {
    const error =
      projectTimeframeError(
        start,
        end
      );

    if (error) {
      throw new Error(error);
    }
  }

  private async assertDepartment(
    departmentId:
      | string
      | undefined,
    organizationId: string
  ) {
    if (!departmentId) {
      return;
    }

    const department =
      await prisma.department.findFirst({
        where: {
          id: departmentId,
          organizationId,
        },

        select: {
          id: true,
        },
      });

    if (!department) {
      throw new Error(
        "Department not found"
      );
    }
  }
}