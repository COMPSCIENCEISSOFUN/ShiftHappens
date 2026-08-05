/** Executes a manager's complete natural-language task request. */
import { prisma } from "@/lib/prisma";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { AITaskParserService } from "@/services/ai-task-parser.service";
import { TaskService } from "@/services/task.service";
import { SettingsRepository } from "@/repositories/settings.repository";
import type { CreateTaskInput } from "@/lib/validations";

type ManagerMembership = {
  role: string;
  departmentMemberships?: { department: { id: string; name: string } }[];
};

export class ManagerTaskAutomationService {
  private parser = new AITaskParserService();
  private taskService = new TaskService();
  private settingsRepository = new SettingsRepository();

  async execute(text: string, organizationId: string, userId: string, membership: ManagerMembership) {
    const parsed = await this.parser.parseTaskDescription(text, organizationId);
    const scope = departmentScopeFor(membership);
    const scopedDepartments = membership.departmentMemberships?.map((item) => item.department) ?? [];
    const availableDepartments = scope === null
      ? await prisma.department.findMany({
          where: { organizationId, archivedAt: null },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : scopedDepartments;

    // A manager with one authorised department should never need to repeat it.
    if (!parsed.departmentId && scope !== null && scope.length === 1) {
      parsed.departmentId = scope[0];
      parsed.departmentName = scopedDepartments[0]?.name ?? null;
    }

    if (!parsed.departmentId) {
      return {
        status: "needs_review" as const,
        message: "Which department should handle this task?",
        parsed,
        departmentOptions: availableDepartments,
      };
    }
    if (!isDepartmentInScope(parsed.departmentId, scope)) {
      return {
        status: "needs_review" as const,
        message: "I can only manage tasks in your authorised departments.",
        parsed,
        departmentOptions: availableDepartments,
      };
    }

    const requiredCertifications = await this.requiredCertificationsFor(organizationId, parsed.departmentId);
    const schedule = this.completeSchedule(text, parsed.scheduledStart, parsed.scheduledEnd);
    const input: CreateTaskInput = {
      title: parsed.title,
      description: parsed.description || undefined,
      location: parsed.location || undefined,
      instructions: parsed.instructions || undefined,
      departmentId: parsed.departmentId,
      requiredHeadcount: parsed.requiredHeadcount,
      requiredCertifications,
      priority: parsed.priority as CreateTaskInput["priority"],
      scheduledStart: schedule.start || undefined,
      scheduledEnd: schedule.end || undefined,
    };

    const created = await this.taskService.create(input, organizationId, userId);
    const task = await this.taskService.getById(created.id, organizationId);
    const assignedStaff = task?.assignments
      .filter((assignment) => assignment.status === "assigned")
      .map((assignment) => assignment.membership?.user.name || "Staff member") ?? [];

    if (assignedStaff.length < parsed.requiredHeadcount) {
      const settings = await this.settingsRepository.getOrCreate(organizationId);
      const reason = settings.allocationMode === "manual"
        ? "Automatic allocation is disabled for this organisation."
        : assignedStaff.length === 0
          ? "No eligible staff were available."
          : `Only ${assignedStaff.length} of ${parsed.requiredHeadcount} requested staff could be assigned.`;
      return { status: "needs_review" as const, message: `Task created, but it needs your review: ${reason}`, parsed, taskId: created.id };
    }

    return {
      status: "completed" as const,
      message: `Task created and ${assignedStaff.length} staff ${assignedStaff.length === 1 ? "member was" : "members were"} assigned.`,
      task,
      assignedStaff,
    };
  }

  private async requiredCertificationsFor(organizationId: string, departmentId: string) {
    const definitions = await prisma.certificationDefinition.findMany({
      where: { organizationId, isActive: true },
      include: { departmentRequirements: true },
    });
    return definitions
      .filter((definition) => definition.departmentRequirements.some((requirement) => requirement.departmentId === departmentId && requirement.isRequired))
      .map((definition) => definition.name);
  }

  /** Completes a common named shift when an AI provider returns one boundary. */
  private completeSchedule(text: string, start: string | null, end: string | null) {
    if (start && end) return { start, end };
    if (!start && !end) return { start: null, end: null };

    const lower = text.toLowerCase();
    const durationHours = lower.includes("morning") || lower.includes("afternoon") || lower.includes("evening")
      ? 5
      : null;
    if (!durationHours) return { start, end };

    if (start && !end) {
      return { start, end: new Date(new Date(start).getTime() + durationHours * 60 * 60 * 1000).toISOString() };
    }
    if (!start && end) {
      return { start: new Date(new Date(end).getTime() - durationHours * 60 * 60 * 1000).toISOString(), end };
    }
    return { start, end };
  }
}
