import { beforeEach, describe, expect, it } from "vitest";
import { CertificationDefinitionRepository } from "@/repositories/certification-definition.repository";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const repository = new CertificationDefinitionRepository();
let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("cert-def-repo");
});

describe("CertificationDefinitionRepository", () => {
  it("creates and lists an organization definition with department requirements", async () => {
    const created = await repository.create({
      organizationId: tenant.orgId,
      name: "Food Safety",
      description: "Food handling qualification",
      departmentRequirements: [
        { departmentId: tenant.departmentId, isRequired: true },
      ],
    });

    expect(created.departmentRequirements[0].departmentId).toBe(
      tenant.departmentId
    );
    expect(created.departmentRequirements[0].isRequired).toBe(true);
    expect(await repository.findByOrganizationId(tenant.orgId)).toHaveLength(1);
  });

  it("scopes individual reads and updates to the organization", async () => {
    const other = await createTenant("cert-def-other");
    const created = await repository.create({
      organizationId: tenant.orgId,
      name: "First Aid",
      departmentRequirements: [],
    });

    expect(await repository.findById(created.id, other.orgId)).toBeNull();
    expect(
      await repository.update(created.id, other.orgId, { name: "Hijacked" })
    ).toBeNull();
  });

  it("excludes inactive definitions from operational lists", async () => {
    const created = await repository.create({
      organizationId: tenant.orgId,
      name: "RSA",
      isActive: false,
      departmentRequirements: [],
    });

    expect(await repository.findByOrganizationId(tenant.orgId)).toEqual([]);
    expect(
      await repository.findByOrganizationId(tenant.orgId, true)
    ).toEqual([expect.objectContaining({ id: created.id, isActive: false })]);
  });

  it("replaces department assignments on an organization-scoped update", async () => {
    const created = await repository.create({
      organizationId: tenant.orgId,
      name: "First Aid",
      departmentRequirements: [],
    });
    const updated = await repository.update(created.id, tenant.orgId, {
      departmentRequirements: [
        { departmentId: tenant.departmentId, isRequired: true },
      ],
    });

    expect(updated?.departmentRequirements).toHaveLength(1);
  });
});
