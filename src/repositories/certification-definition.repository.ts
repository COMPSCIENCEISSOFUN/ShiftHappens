import { prisma } from "@/lib/prisma";

export interface DepartmentRequirementInput {
  departmentId: string;
  isRequired: boolean;
}

const definitionInclude = {
  departmentRequirements: {
    include: { department: true },
    orderBy: { department: { name: "asc" as const } },
  },
};

export class CertificationDefinitionRepository {
  async create(data: {
    organizationId: string;
    name: string;
    description?: string;
    isActive?: boolean;
    departmentRequirements: DepartmentRequirementInput[];
  }) {
    return prisma.certificationDefinition.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        description: data.description,
        isActive: data.isActive,
        departmentRequirements: {
          create: data.departmentRequirements,
        },
      },
      include: definitionInclude,
    });
  }

  async findById(id: string, organizationId: string) {
    return prisma.certificationDefinition.findFirst({
      where: { id, organizationId },
      include: definitionInclude,
    });
  }

  async findByOrganizationId(organizationId: string, includeInactive = false) {
    return prisma.certificationDefinition.findMany({
      where: {
        organizationId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: definitionInclude,
      orderBy: { name: "asc" },
    });
  }

  async nameExists(
    organizationId: string,
    name: string,
    excludeId?: string
  ) {
    return (
      (await prisma.certificationDefinition.count({
        where: {
          organizationId,
          name: { equals: name, mode: "insensitive" },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      })) > 0
    );
  }

  async departmentsBelongToOrganization(
    organizationId: string,
    departmentIds: string[]
  ) {
    if (departmentIds.length === 0) return true;
    const count = await prisma.department.count({
      where: { organizationId, id: { in: departmentIds } },
    });
    return count === new Set(departmentIds).size;
  }

  async update(
    id: string,
    organizationId: string,
    data: {
      name?: string;
      description?: string | null;
      isActive?: boolean;
      departmentRequirements?: DepartmentRequirementInput[];
    }
  ) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.certificationDefinition.findFirst({
        where: { id, organizationId },
      });
      if (!existing) return null;

      const scalarData = {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      };
      if (Object.keys(scalarData).length > 0) {
        await tx.certificationDefinition.update({
          where: { id },
          data: scalarData,
        });
      }

      if (data.departmentRequirements) {
        await tx.certificationDefinitionDepartment.deleteMany({
          where: { certificationDefinitionId: id },
        });
        if (data.departmentRequirements.length > 0) {
          await tx.certificationDefinitionDepartment.createMany({
            data: data.departmentRequirements.map((requirement) => ({
              certificationDefinitionId: id,
              ...requirement,
            })),
          });
        }
      }

      return tx.certificationDefinition.findUniqueOrThrow({
        where: { id },
        include: definitionInclude,
      });
    });
  }

  async delete(id: string, organizationId: string) {
    const result = await prisma.certificationDefinition.deleteMany({
      where: { id, organizationId },
    });
    return result.count > 0;
  }
}
