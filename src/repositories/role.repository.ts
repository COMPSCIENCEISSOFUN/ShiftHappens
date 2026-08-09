/**
 * Role Repository (Entity Layer)
 * 
 * Data access layer for custom role management.
 * Handles CRUD operations for roles and their permission assignments.
 * All queries are org-scoped for multi-tenant isolation.
 * 
 * Permissions are managed as a set — updates replace all existing
 * permissions rather than adding/removing individually.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";

export class RoleRepository {
  /**
   * Creates a new role with assigned permissions.
   * Uses nested create for atomic role + permission creation.
   */
  async create(data: {
    name: string;
    displayLabel: string;
    description?: string;
    organizationId: string;
    permissionIds: string[];
  }) {
    return prisma.role.create({
      data: {
        name: data.name,
        displayLabel: data.displayLabel,
        description: data.description,
        organizationId: data.organizationId,
        rolePermissions: {
          create: data.permissionIds.map((permissionId) => ({
            permissionId,
          })),
        },
      },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });
  }

  /** Finds a role by ID with its assigned permissions */
  async findById(id: string) {
    return prisma.role.findUnique({
      where: { id },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });
  }

  /**
   * Lists all roles for an organization with permissions.
   * Org-scoped for tenant isolation.
   */
  async findByOrganizationId(organizationId: string) {
    return prisma.role.findMany({
      where: { organizationId },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
        /*
         * How many people hold each role.
         *
         * The roles list showed a permission count and nothing about reach, so
         * the delete confirmation could only say "anyone currently holding this
         * role loses the permissions it grants" — true of every role, and
         * therefore no help in deciding whether to press the button. A count
         * turns that sentence into a fact about THIS role.
         */
        _count: { select: { memberCustomRoles: true } },
      },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Updates a role's display label, description, and/or permissions.
   * Permission updates use delete-then-create to replace the full set.
   */
  async update(
    id: string,
    data: {
      displayLabel?: string;
      description?: string;
      permissionIds?: string[];
    }
  ) {
    // Update basic fields
    await prisma.role.update({
      where: { id },
      data: {
        ...(data.displayLabel && { displayLabel: data.displayLabel }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });

    // Replace permissions if provided
    if (data.permissionIds) {
      await prisma.rolePermission.deleteMany({ where: { roleId: id } });
      await prisma.rolePermission.createMany({
        data: data.permissionIds.map((permissionId) => ({
          roleId: id,
          permissionId,
        })),
      });
    }

    // Return updated role with permissions
    return this.findById(id) as Promise<NonNullable<Awaited<ReturnType<typeof this.findById>>>>;
  }

  /** Deletes a role — cascade deletes its RolePermission entries */
  async delete(id: string) {
    return prisma.role.delete({ where: { id } });
  }

  /**
   * Checks if a role name already exists within an organization.
   * Optional excludeId for update operations.
   */
  async nameExistsInOrg(
    name: string,
    organizationId: string,
    excludeId?: string
  ): Promise<boolean> {
    const count = await prisma.role.count({
      where: {
        name,
        organizationId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return count > 0;
  }

  /**
   * Is a role with this DISPLAY LABEL already in the organisation?
   *
   * Case-insensitive, because "Shift Lead" and "shift lead" are the same role
   * to anyone reading a dropdown, and refusing only the exact match would let
   * the list fill with near-duplicates.
   *
   * The database's unique index is on `name`, which is derived — so it enforces
   * the rule but cannot express it in the terms the user typed. This is what
   * lets the service refuse with "a role called Shift Lead already exists"
   * instead of a constraint violation about a string nobody chose.
   */
  async labelExistsInOrg(
    displayLabel: string,
    organizationId: string,
    excludeId?: string
  ): Promise<boolean> {
    const count = await prisma.role.count({
      where: {
        displayLabel: { equals: displayLabel.trim(), mode: "insensitive" },
        organizationId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return count > 0;
  }

  /** Every stored `name` in an organisation, for deriving a fresh one. */
  async takenNamesInOrg(organizationId: string): Promise<string[]> {
    const roles = await prisma.role.findMany({
      where: { organizationId },
      select: { name: true },
    });
    return roles.map((r) => r.name);
  }

  /**
   * The names behind a set of permission ids.
   *
   * The role forms speak in ids and every authorisation check in the codebase
   * speaks in names, so something has to translate between them. Doing it here
   * rather than in the service keeps the query in the Entity layer, and doing
   * it in one round trip rather than per id keeps a fourteen-permission role
   * from costing fourteen queries.
   *
   * Ids that match nothing are simply absent from the result. The caller is
   * asking "what would this grant", and an id that names no permission grants
   * nothing.
   */
  async permissionNamesByIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const permissions = await prisma.permission.findMany({
      where: { id: { in: [...ids] } },
      select: { name: true },
    });
    return permissions.map((p) => p.name);
  }

  /** Gets all available permissions (global, not org-scoped) */
  async getAllPermissions() {
    return prisma.permission.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
  }
}