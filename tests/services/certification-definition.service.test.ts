import { beforeEach, describe, expect, it } from "vitest";
import { CertificationDefinitionService } from "@/services/certification-definition.service";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new CertificationDefinitionService();
let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("cert-def-service");
});

describe("CertificationDefinitionService", () => {
  it("prevents duplicate names within an organization, ignoring case", async () => {
    await service.create(
      tenant.orgId,
      { name: "Food Safety", departmentRequirements: [] },
      tenant.admin.userId
    );

    await expect(
      service.create(
        tenant.orgId,
        { name: " food safety ", departmentRequirements: [] },
        tenant.admin.userId
      )
    ).rejects.toThrow("Certification definition name already exists");
  });

  it("rejects a department owned by another organization", async () => {
    const other = await createTenant("cert-def-foreign");
    await expect(
      service.create(
        tenant.orgId,
        {
          name: "First Aid",
          departmentRequirements: [
            { departmentId: other.departmentId, isRequired: true },
          ],
        },
        tenant.admin.userId
      )
    ).rejects.toThrow("Invalid department assignment");
  });

  it("updates assignments atomically and deletes only inside the tenant", async () => {
    const created = await service.create(
      tenant.orgId,
      { name: "First Aid", departmentRequirements: [] },
      tenant.admin.userId
    );
    const other = await createTenant("cert-def-delete-other");

    const updated = await service.update(
      created.id,
      tenant.orgId,
      {
        departmentRequirements: [
          { departmentId: tenant.departmentId, isRequired: true },
        ],
      },
      tenant.admin.userId
    );
    expect(updated.departmentRequirements).toHaveLength(1);

    await expect(
      service.delete(created.id, other.orgId, other.admin.userId)
    ).rejects.toThrow("Certification definition not found");
    await expect(service.getById(created.id, tenant.orgId)).resolves.not.toBeNull();
  });

  it("canonicalizes active submissions and rejects unknown or inactive names", async () => {
    await service.create(
      tenant.orgId,
      { name: "Food Safety", departmentRequirements: [] },
      tenant.admin.userId
    );
    await service.create(
      tenant.orgId,
      { name: "Old Licence", isActive: false, departmentRequirements: [] },
      tenant.admin.userId
    );

    await expect(
      service.resolveSubmissionName(tenant.orgId, " food safety ")
    ).resolves.toBe("Food Safety");
    await expect(
      service.resolveSubmissionName(tenant.orgId, "Unknown")
    ).rejects.toThrow("Select an active certification definition");
    await expect(
      service.resolveSubmissionName(tenant.orgId, "Old Licence")
    ).rejects.toThrow("Select an active certification definition");
  });
});
