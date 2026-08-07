import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { projectTimeframeError } from "@/lib/project-timeframe";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import type { CreateProjectInput, UpdateProjectInput } from "@/lib/validations";

export class ProjectService {
  private auditService = new AuditLogService();

  async create(input: CreateProjectInput, organizationId: string, userId: string) {
    this.validateDates(input.plannedStart, input.plannedEnd);
    await this.assertDepartment(input.departmentId, organizationId);
    const project = await prisma.project.create({
      data: {
        organizationId,
        departmentId: input.departmentId,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "medium",
        plannedStart: input.plannedStart ? new Date(input.plannedStart) : undefined,
        plannedEnd: input.plannedEnd ? new Date(input.plannedEnd) : undefined,
        createdById: userId,
      },
      include: this.include,
    });
    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.PROJECT_CREATED,
      entityType: "project",
      entityId: project.id,
      details: { title: project.title, departmentId: project.departmentId },
    });
    return project;
  }

  async list(organizationId: string, departmentScope?: string[] | null) {
    return prisma.project.findMany({
      where: {
        organizationId,
        ...(departmentScope === null || departmentScope === undefined
          ? {}
          : { departmentId: { in: departmentScope } }),
      },
      include: this.include,
      orderBy: [{ plannedStart: "asc" }, { createdAt: "desc" }],
    });
  }

  async get(projectId: string, organizationId: string) {
    return prisma.project.findFirst({
      where: { id: projectId, organizationId },
      include: this.include,
    });
  }

  async update(projectId: string, organizationId: string, input: UpdateProjectInput, userId: string) {
    const existing = await this.get(projectId, organizationId);
    if (!existing) throw new Error("Project not found");
    await this.assertDepartment(input.departmentId, organizationId);
    const plannedStart = input.plannedStart === "" ? null : input.plannedStart ?? existing.plannedStart?.toISOString();
    const plannedEnd = input.plannedEnd === "" ? null : input.plannedEnd ?? existing.plannedEnd?.toISOString();
    this.validateDates(plannedStart ?? undefined, plannedEnd ?? undefined);
    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        title: input.title,
        description: input.description,
        departmentId: input.departmentId,
        priority: input.priority,
        status: input.status,
        plannedStart: plannedStart ? new Date(plannedStart) : plannedStart === null ? null : undefined,
        plannedEnd: plannedEnd ? new Date(plannedEnd) : plannedEnd === null ? null : undefined,
      },
      include: this.include,
    });
    await this.auditService.log({ organizationId, userId, action: ACTIONS.PROJECT_UPDATED, entityType: "project", entityId: project.id, details: { title: project.title, status: project.status } });
    return project;
  }

  private validateDates(start?: string, end?: string) {
    const error = projectTimeframeError(start, end);
    if (error) throw new Error(error);
  }

  private async assertDepartment(departmentId: string | undefined, organizationId: string) {
    if (!departmentId) return;
    const department = await prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true },
    });
    if (!department) throw new Error("Department not found");
  }

  private include = {
    department: { select: { id: true, name: true, color: true } },
    tasks: {
      select: { id: true, title: true, status: true, priority: true, scheduledStart: true, scheduledEnd: true, requiredHeadcount: true, assignments: { select: { id: true, status: true } } },
      orderBy: [{ scheduledStart: "asc" as const }, { createdAt: "asc" as const }],
    },
  } satisfies Prisma.ProjectInclude;
}
