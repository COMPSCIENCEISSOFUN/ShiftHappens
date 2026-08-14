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
     * Both plan gates first, as in every other create that is capped — before
     * the dates are validated and before any department is read. An
     * organisation that cannot have a project should be told that, not walked
     * through the reasons its input was also wrong.
     *
     * The FEATURE, then the count, and the order matters because the two say
     * different things. The limit error reads "projects limit reached (0/0)",
     * which describes a full container; the feature error names Projects and
     * the plan that includes them. On a plan whose allowance is zero the
     * second is the true account of what happened.
     *
     * The limit is still enforced immediately after, because it is the one
     * that bites on Pro — where the feature is included and the allowance is
     * ten plus whatever was bought.
     */
    await this.subscriptionService.enforceFeatureAccess(organizationId, "projects");
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

  /**
   * Deletes a project, leaving its work items behind as ordinary tasks.
   *
   * ## Why the tasks are not deleted with it
   *
   * A "work item" here is a real shift: it has a time, it has people assigned
   * to it, and some of them have already worked it. Cascading the delete would
   * cancel somebody's roster and erase completed hours because an admin tidied
   * up a grouping. `Task.project` is `onDelete: SetNull` for exactly that
   * reason, so they survive, keep their assignments, and stop belonging to a
   * project.
   *
   * That also makes this recoverable in the way that matters: the grouping is
   * gone and can be rebuilt, but no work was destroyed.
   *
   * The count is read BEFORE the delete because it is the one fact the audit
   * entry cannot get afterwards — the rows have stopped pointing at anything by
   * then, and "deleted a project" without saying it took four work items with
   * it out of a project is not the same statement.
   */
  async remove(
    projectId: string,
    organizationId: string,
    userId: string
  ) {
    const existing = await this.get(projectId, organizationId);
    if (!existing) {
      throw new Error("Project not found");
    }

    /*
     * Only an EMPTY project can be deleted.
     *
     * Projects are permanent once work has happened inside them: they record
     * why a set of shifts was grouped, who owned it and over what period, and
     * the plan quota counts them for that reason. Letting one be removed once
     * it holds work would also hand any organisation unlimited projects for the
     * price of emptying one.
     *
     * The exception exists for the only genuinely unfair case: a project
     * created by mistake — a typo in the title, the wrong department — which
     * has nothing in it to audit and would otherwise consume a permanent slot
     * forever, remediable only by buying another.
     *
     * Zero work items is the whole test. Nothing else about the project can
     * make it disposable, and nothing about it being empty makes it worth
     * keeping.
     */
    if (existing.tasks.length > 0) {
      throw new Error(
        "A project with work items cannot be deleted. Projects are kept as a permanent record once work has been added."
      );
    }

    const unlinkedTasks = existing.tasks.length;

    const removed = await this.projectRepo.remove(projectId, organizationId);
    // `deleteMany` scoped on the tenant removes nothing when the id belongs
    // elsewhere. `get` already refused that case, so reaching here means it
    // vanished between the two reads — reported as not found rather than as
    // a success that deleted nothing.
    if (removed === 0) {
      throw new Error("Project not found");
    }

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.PROJECT_DELETED,
      entityType: "project",
      entityId: projectId,
      details: {
        title: existing.title,
        departmentId: existing.departmentId,
        unlinkedTasks,
      },
    });

    return { unlinkedTasks };
  }

  async update(
    projectId: string,
    organizationId: string,
    input: UpdateProjectInput,
    userId: string
  ) {
    /*
     * `projects`, Pro and above from 2026-08-14.
     *
     * Only the MUTATIONS are gated. `list` and `get` deliberately are not —
     * the rows survive a downgrade and come back intact on upgrade, so there
     * is nothing for a read to protect, and gating it would put the data
     * beyond export, audit and migration alike. The FEATURE is hidden in the
     * UI instead: a Free organisation sees no Projects link and an upsell in
     * place of the page.
     *
     * `remove` is likewise ungated: deleting an empty project created by
     * mistake is tidying up after yourself, and refusing it would strand a
     * Free organisation with a row it can neither use nor clear.
     */
    await this.subscriptionService.enforceFeatureAccess(organizationId, "projects");

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
    // `projects`, Pro and above — same gate and same reasoning as `update`
    // above, which is where the read/mutate split is explained.
    await this.subscriptionService.enforceFeatureAccess(organizationId, "projects");

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
