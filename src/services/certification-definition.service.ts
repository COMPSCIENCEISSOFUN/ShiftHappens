import { CertificationDefinitionRepository } from "@/repositories/certification-definition.repository";
import { ACTIONS, AuditLogService } from "@/services/audit-log.service";
import type {
  CreateCertificationDefinitionInput,
  UpdateCertificationDefinitionInput,
} from "@/lib/validations";

export class CertificationDefinitionService {
  private repository = new CertificationDefinitionRepository();
  private auditService = new AuditLogService();

  async create(
    organizationId: string,
    input: CreateCertificationDefinitionInput,
    userId?: string
  ) {
    const name = input.name.trim();
    await this.assertNameAvailable(organizationId, name);
    await this.assertDepartments(
      organizationId,
      input.departmentRequirements ?? []
    );

    const definition = await this.repository.create({
      organizationId,
      name,
      description: input.description || undefined,
      isActive: input.isActive,
      departmentRequirements: input.departmentRequirements ?? [],
    });

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CERTIFICATION_DEFINITION_CREATED,
      entityType: "certification_definition",
      entityId: definition.id,
      details: { name: definition.name },
    });
    return definition;
  }

  async getByOrganization(organizationId: string, includeInactive = false) {
    return this.repository.findByOrganizationId(organizationId, includeInactive);
  }

  async getById(id: string, organizationId: string) {
    return this.repository.findById(id, organizationId);
  }

  async resolveSubmissionName(organizationId: string, submittedName: string) {
    const definitions = await this.repository.findByOrganizationId(
      organizationId,
      true
    );
    if (definitions.length === 0) return submittedName.trim();

    const normalized = submittedName.trim().toLocaleLowerCase();
    const match = definitions.find(
      (definition) =>
        definition.isActive && definition.name.toLocaleLowerCase() === normalized
    );
    if (!match) throw new Error("Select an active certification definition");
    return match.name;
  }

  async update(
    id: string,
    organizationId: string,
    input: UpdateCertificationDefinitionInput,
    userId?: string
  ) {
    const existing = await this.repository.findById(id, organizationId);
    if (!existing) throw new Error("Certification definition not found");
    const name = input.name?.trim();
    if (name) await this.assertNameAvailable(organizationId, name, id);
    if (input.departmentRequirements) {
      await this.assertDepartments(organizationId, input.departmentRequirements);
    }

    const definition = await this.repository.update(id, organizationId, {
      ...input,
      name,
      description: input.description === "" ? null : input.description,
    });
    if (!definition) throw new Error("Certification definition not found");

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CERTIFICATION_DEFINITION_UPDATED,
      entityType: "certification_definition",
      entityId: id,
      details: { name: definition.name, isActive: definition.isActive },
    });
    return definition;
  }

  async delete(id: string, organizationId: string, userId?: string) {
    const existing = await this.repository.findById(id, organizationId);
    if (!existing) throw new Error("Certification definition not found");
    if (!(await this.repository.delete(id, organizationId))) {
      throw new Error("Certification definition not found");
    }

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CERTIFICATION_DEFINITION_DELETED,
      entityType: "certification_definition",
      entityId: id,
      details: { name: existing.name },
    });
  }

  private async assertNameAvailable(
    organizationId: string,
    name: string,
    excludeId?: string
  ) {
    if (await this.repository.nameExists(organizationId, name, excludeId)) {
      throw new Error("Certification definition name already exists");
    }
  }

  private async assertDepartments(
    organizationId: string,
    requirements: { departmentId: string; isRequired: boolean }[]
  ) {
    const valid = await this.repository.departmentsBelongToOrganization(
      organizationId,
      requirements.map((item) => item.departmentId)
    );
    if (!valid) throw new Error("Invalid department assignment");
  }
}
