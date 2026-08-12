import { DepartmentRepository } from "@/repositories/department.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { ProjectRepository } from "@/repositories/project.repository";
import { projectTimeframeError } from "@/lib/project-timeframe";
import {
  AuditLogService,
  ACTIONS,
} from "@/services/audit-log.service";
import { SubscriptionService } from "@/services/subscription.service";

import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "@/lib/validations";

export class ProjectService {
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();
  private projectRepo = new ProjectRepository();
  private departmentRepo = new DepartmentRepository();
  private membershipRepo = new MembershipRepository();

  async create(
    input: CreateProjectInput,
    organizationId: string,
    userId: string
  ) {
    /*
     * First, as in every other create that is capped — before the dates are
     * validated and before any department is read. An organisation that is over
     * its limit should be told that, not walked through the reasons its input
     * was also wrong.
     */
    await this.subscriptionService.enforceResourceLimit(organizationId, "projects");

    this.validateDates(
      input.plannedStart,
      input.plannedEnd
    );

    const departmentIds = [...new Set(input.departmentIds ?? (input.departmentId ? [input.departmentId] : []))];
    if (departmentIds.length === 0) throw new Error("Select at least one department");
    const owned = await this.departmentRepo.countActiveOwned(departmentIds, organizationId);
    if (owned !== departmentIds.length) throw new Error("Department not found");

    const project =
      await this.projectRepo.create({
        organizationId,
        departmentIds,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "medium",
        staffingMode: input.staffingMode ?? "task_based",
        plannedStart: input.plannedStart
          ? new Date(input.plannedStart)
          : undefined,
        plannedEnd: input.plannedEnd ? new Date(input.plannedEnd) : undefined,
        createdById: userId,
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
      | null,
    viewer?: { membershipId: string; userId: string; role: string }
  ) {
    const projects = await this.projectRepo.findByOrganizationId(organizationId, departmentScope);
    if (!viewer || viewer.role === "company_admin") return projects;
    return projects.filter((project) => project.staffingMode !== "project_team" || project.createdById === viewer.userId || project.projectMembers.some((member) => member.membershipId === viewer.membershipId));
  }

  async get(
    projectId: string,
    organizationId: string
  ) {
    return this.projectRepo.findById(projectId, organizationId);
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
      await this.projectRepo.update(
        projectId,
        {
          title: input.title,
          description: input.description,
          departmentId: input.departmentId,
          priority: input.priority,
          staffingMode: input.staffingMode,
          status: input.status,
          plannedStart: plannedStart
            ? new Date(plannedStart)
            : plannedStart === null
              ? null
              : undefined,
          plannedEnd: plannedEnd
            ? new Date(plannedEnd)
            : plannedEnd === null
              ? null
              : undefined,
        },
        clearsTeam
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
        await this.membershipRepo.findActiveStaffIds(
          uniqueMembershipIds,
          organizationId,
          project.departmentId
        );

      if (
        validMembers.length !==
        uniqueMembershipIds.length
      ) {
        throw new Error(
          "One or more selected team members are invalid, inactive, outside the organization, or outside the project department"
        );
      }
    }

    await this.projectRepo.replaceTeam(projectId, uniqueMembershipIds);

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
      | null
      | undefined,
    organizationId: string
  ) {
    if (!departmentId) {
      return;
    }

    const owned = await this.departmentRepo.countOwned(
      [departmentId],
      organizationId
    );

    if (owned === 0) {
      throw new Error(
        "Department not found"
      );
    }
  }
}
