/**
 * Tests for Industry Template Service (Control Layer)
 *
 * Verifies template CRUD, name uniqueness, structure validation,
 * toggle status, and usage count aggregation.
 * Platform-level service — not org-scoped.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { IndustryTemplateService } from "@/services/industry-template.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const templateService = new IndustryTemplateService();
type TemplateInput = Parameters<IndustryTemplateService["createTemplate"]>[0];

// --- Reusable test data ---

const validDepartments = [
  { name: "Kitchen", description: "Cooking area", color: "#FF0000" },
  { name: "Bar", description: "Drinks area", color: "#00FF00" },
];

const validWorkRules = [
  {
    name: "Standard break",
    type: "break_interval" as const,
    hoursThreshold: 6,
    breakHours: 1,
    reason: "Standard rest period",
  },
];

const validCertifications = ["Food Safety", "First Aid"];

/** Builds a valid createTemplate input with optional overrides */
function makeInput(overrides: Partial<TemplateInput> = {}): TemplateInput {
  return {
    name: "Hospitality",
    icon: "UtensilsCrossed",
    description: "Restaurant and hotel template",
    departments: validDepartments,
    workRules: validWorkRules,
    certifications: validCertifications,
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("IndustryTemplateService", () => {
  // ─── getAllTemplates ───────────────────────────────────────

  describe("getAllTemplates", () => {
    it("returns templates with usage counts", async () => {
      const template = await templateService.createTemplate(makeInput());

      await prisma.organization.create({
        data: { name: "Test Org", slug: "test-org", templateId: template.id },
      });

      const result = await templateService.getAllTemplates();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Hospitality");
      expect(result[0].usageCount).toBe(1);
    });

    it("returns zero usage count for unused templates", async () => {
      await templateService.createTemplate(makeInput());

      const result = await templateService.getAllTemplates();

      expect(result).toHaveLength(1);
      expect(result[0].usageCount).toBe(0);
    });

    it("returns empty array when no templates exist", async () => {
      const result = await templateService.getAllTemplates();

      expect(result).toHaveLength(0);
    });

    it("aggregates usage counts across multiple templates", async () => {
      const t1 = await templateService.createTemplate(
        makeInput({ name: "Template A" })
      );
      const t2 = await templateService.createTemplate(
        makeInput({ name: "Template B" })
      );

      await prisma.organization.create({
        data: { name: "Org 1", slug: "org-1", templateId: t1.id },
      });
      await prisma.organization.create({
        data: { name: "Org 2", slug: "org-2", templateId: t1.id },
      });
      await prisma.organization.create({
        data: { name: "Org 3", slug: "org-3", templateId: t2.id },
      });

      const result = await templateService.getAllTemplates();

      const a = result.find((t) => t.name === "Template A");
      const b = result.find((t) => t.name === "Template B");

      expect(a!.usageCount).toBe(2);
      expect(b!.usageCount).toBe(1);
    });
  });

  // ─── getActiveTemplates ───────────────────────────────────

  describe("getActiveTemplates", () => {
    it("returns only active templates", async () => {
      await templateService.createTemplate(
        makeInput({ name: "Active Template" })
      );
      const inactive = await templateService.createTemplate(
        makeInput({ name: "Inactive Template" })
      );
      await templateService.toggleStatus(inactive.id);

      const result = await templateService.getActiveTemplates();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Active Template");
    });

    it("returns empty array when no active templates exist", async () => {
      const template = await templateService.createTemplate(makeInput());
      await templateService.toggleStatus(template.id);

      const result = await templateService.getActiveTemplates();

      expect(result).toHaveLength(0);
    });
  });

  // ─── getTemplateById ──────────────────────────────────────

  describe("getTemplateById", () => {
    it("returns a template by ID", async () => {
      const created = await templateService.createTemplate(makeInput());

      const result = await templateService.getTemplateById(created.id);

      expect(result.name).toBe("Hospitality");
      expect(result.icon).toBe("UtensilsCrossed");
      expect(result.description).toBe("Restaurant and hotel template");
    });

    it("throws for non-existent ID", async () => {
      await expect(
        templateService.getTemplateById("non-existent-id")
      ).rejects.toThrow("Template not found");
    });
  });

  // ─── createTemplate ───────────────────────────────────────

  describe("createTemplate", () => {
    it("creates a template with all fields", async () => {
      const result = await templateService.createTemplate(makeInput());

      expect(result.name).toBe("Hospitality");
      expect(result.icon).toBe("UtensilsCrossed");
      expect(result.description).toBe("Restaurant and hotel template");
      expect(result.isActive).toBe(true);
      expect(result.isAiGenerated).toBe(false);
      expect(result.departments).toEqual(validDepartments);
      expect(result.workRules).toEqual(validWorkRules);
      expect(result.certifications).toEqual(validCertifications);
    });

    it("trims name and description", async () => {
      const result = await templateService.createTemplate(
        makeInput({ name: "  Padded Name  ", description: "  Padded Desc  " })
      );

      expect(result.name).toBe("Padded Name");
      expect(result.description).toBe("Padded Desc");
    });

    it("sets isAiGenerated flag when specified", async () => {
      const result = await templateService.createTemplate(
        makeInput({ isAiGenerated: true })
      );

      expect(result.isAiGenerated).toBe(true);
    });

    it("throws for duplicate template name", async () => {
      await templateService.createTemplate(makeInput());

      await expect(
        templateService.createTemplate(makeInput())
      ).rejects.toThrow("A template with this name already exists");
    });

    it("allows templates with different names", async () => {
      await templateService.createTemplate(makeInput({ name: "Template A" }));
      const b = await templateService.createTemplate(
        makeInput({ name: "Template B" })
      );

      expect(b.name).toBe("Template B");
    });

    // --- Structure validation ---

    it("throws when no departments provided", async () => {
      await expect(
        templateService.createTemplate(makeInput({ departments: [] }))
      ).rejects.toThrow("At least one department is required");
    });

    it("throws when departments exceed maximum of 10", async () => {
      const tooMany: TemplateInput["departments"] = Array.from({ length: 11 }, (_, i) => ({
        name: `Dept ${i}`,
        description: `Department ${i}`,
        color: `#${String(i).padStart(6, "0")}`,
      }));

      await expect(
        templateService.createTemplate(makeInput({ departments: tooMany }))
      ).rejects.toThrow("Maximum 10 departments per template");
    });

    it("accepts exactly 10 departments", async () => {
      const maxDepts = Array.from({ length: 10 }, (_, i) => ({
        name: `Dept ${i}`,
        description: `Department ${i}`,
        color: `#${String(i).padStart(6, "0")}`,
      }));

      const result = await templateService.createTemplate(
        makeInput({ departments: maxDepts })
      );

      expect((result.departments as unknown[]).length).toBe(10);
    });

    it("throws when work rules exceed maximum of 10", async () => {
      const tooMany: TemplateInput["workRules"] = Array.from({ length: 11 }, (_, i) => ({
        name: `Rule ${i}`,
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
        reason: "Rest",
      }));

      await expect(
        templateService.createTemplate(makeInput({ workRules: tooMany }))
      ).rejects.toThrow("Maximum 10 work rules per template");
    });

    it("throws when certifications exceed maximum of 15", async () => {
      const tooMany = Array.from({ length: 16 }, (_, i) => `Cert ${i}`);

      await expect(
        templateService.createTemplate(makeInput({ certifications: tooMany }))
      ).rejects.toThrow("Maximum 15 certifications per template");
    });

    it("allows zero work rules", async () => {
      const result = await templateService.createTemplate(
        makeInput({ workRules: [] })
      );

      expect(result.workRules).toEqual([]);
    });

    it("allows zero certifications", async () => {
      const result = await templateService.createTemplate(
        makeInput({ certifications: [] })
      );

      expect(result.certifications).toEqual([]);
    });

    it("throws for department with whitespace-only name", async () => {
      await expect(
        templateService.createTemplate(
          makeInput({
            departments: [
              { name: "  ", description: "Valid", color: "#FF0000" },
            ],
          })
        )
      ).rejects.toThrow("Department name is required");
    });

    it("throws for department with whitespace-only color", async () => {
      await expect(
        templateService.createTemplate(
          makeInput({
            departments: [
              { name: "Valid Dept", description: "Valid", color: "  " },
            ],
          })
        )
      ).rejects.toThrow("Department color is required");
    });

    it("throws for work rule with whitespace-only name", async () => {
      await expect(
        templateService.createTemplate(
          makeInput({
            workRules: [
              { name: "  ", type: "break_interval", reason: "Rest" },
            ],
          })
        )
      ).rejects.toThrow("Work rule name is required");
    });

    it("throws for invalid work rule type", async () => {
      await expect(
        templateService.createTemplate(
          makeInput({
            workRules: [
              {
                name: "Bad Rule",
                type: "invalid_type" as unknown as TemplateInput["workRules"][number]["type"],
                reason: "None",
              },
            ],
          })
        )
      ).rejects.toThrow("Invalid work rule type: invalid_type");
    });
  });

  // ─── updateTemplate ───────────────────────────────────────

  describe("updateTemplate", () => {
    it("updates template fields", async () => {
      const template = await templateService.createTemplate(makeInput());

      const updated = await templateService.updateTemplate(template.id, {
        name: "Updated Name",
        description: "Updated description",
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.description).toBe("Updated description");
    });

    it("trims updated name and description", async () => {
      const template = await templateService.createTemplate(makeInput());

      const updated = await templateService.updateTemplate(template.id, {
        name: "  Trimmed  ",
        description: "  Also trimmed  ",
      });

      expect(updated.name).toBe("Trimmed");
      expect(updated.description).toBe("Also trimmed");
    });

    it("throws for non-existent template", async () => {
      await expect(
        templateService.updateTemplate("non-existent-id", { name: "New" })
      ).rejects.toThrow("Template not found");
    });

    it("throws when renaming to an existing name", async () => {
      await templateService.createTemplate(makeInput({ name: "Existing" }));
      const template = await templateService.createTemplate(
        makeInput({ name: "Other" })
      );

      await expect(
        templateService.updateTemplate(template.id, { name: "Existing" })
      ).rejects.toThrow("A template with this name already exists");
    });

    it("allows keeping the same name without collision", async () => {
      const template = await templateService.createTemplate(makeInput());

      const updated = await templateService.updateTemplate(template.id, {
        name: "Hospitality",
        description: "Changed description only",
      });

      expect(updated.name).toBe("Hospitality");
      expect(updated.description).toBe("Changed description only");
    });

    it("validates structure when updating departments", async () => {
      const template = await templateService.createTemplate(makeInput());

      await expect(
        templateService.updateTemplate(template.id, { departments: [] })
      ).rejects.toThrow("At least one department is required");
    });

    it("validates work rules when updating them", async () => {
      const template = await templateService.createTemplate(makeInput());

      const badRules: TemplateInput["workRules"] = Array.from({ length: 11 }, (_, i) => ({
        name: `Rule ${i}`,
        type: "break_interval" as const,
        hoursThreshold: 6,
        breakHours: 1,
        reason: "Rest",
      }));

      await expect(
        templateService.updateTemplate(template.id, { workRules: badRules })
      ).rejects.toThrow("Maximum 10 work rules per template");
    });

    it("uses existing template data for validation when only some content fields change", async () => {
      const template = await templateService.createTemplate(makeInput());

      // Updating only certifications — should still pass since existing
      // departments (2) and work rules (1) are within limits
      const updated = await templateService.updateTemplate(template.id, {
        certifications: ["Updated Cert"],
      });

      expect(updated.certifications).toEqual(["Updated Cert"]);
    });

    it("returns template unchanged when no fields provided", async () => {
      const template = await templateService.createTemplate(makeInput());

      const result = await templateService.updateTemplate(template.id, {});

      expect(result.name).toBe("Hospitality");
      expect(result.id).toBe(template.id);
    });

    it("updates only provided fields without affecting others", async () => {
      const template = await templateService.createTemplate(makeInput());

      const updated = await templateService.updateTemplate(template.id, {
        icon: "NewIcon",
      });

      expect(updated.icon).toBe("NewIcon");
      expect(updated.name).toBe("Hospitality");
      expect(updated.description).toBe("Restaurant and hotel template");
      expect(updated.departments).toEqual(validDepartments);
    });

    it("updates isActive via update method", async () => {
      const template = await templateService.createTemplate(makeInput());

      const updated = await templateService.updateTemplate(template.id, {
        isActive: false,
      });

      expect(updated.isActive).toBe(false);
    });
  });

  // ─── toggleStatus ─────────────────────────────────────────

  describe("toggleStatus", () => {
    it("deactivates an active template", async () => {
      const template = await templateService.createTemplate(makeInput());
      expect(template.isActive).toBe(true);

      const toggled = await templateService.toggleStatus(template.id);

      expect(toggled.isActive).toBe(false);
    });

    it("activates an inactive template", async () => {
      const template = await templateService.createTemplate(makeInput());
      await templateService.toggleStatus(template.id); // deactivate first

      const toggled = await templateService.toggleStatus(template.id);

      expect(toggled.isActive).toBe(true);
    });

    it("throws for non-existent template", async () => {
      await expect(
        templateService.toggleStatus("non-existent-id")
      ).rejects.toThrow("Template not found");
    });
  });
});
