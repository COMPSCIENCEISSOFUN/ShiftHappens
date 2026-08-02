/**
 * Industry templates — platform-level, not org-scoped.
 *
 * Two readers with different needs: platform admin sees everything, onboarding
 * sees only active ones. Deletion is soft, so a template an organisation was
 * built from never disappears from under it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { IndustryTemplateRepository } from "@/repositories/industry-template.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant } from "../helpers/fixtures";

const repo = new IndustryTemplateRepository();

beforeEach(async () => {
  await cleanDatabase();
});

async function template(name: string, overrides: Record<string, unknown> = {}) {
  return repo.create({
    name,
    icon: "utensils",
    description: `${name} template`,
    departments: [{ name: "Kitchen" }],
    workRules: [{ type: "max_hours_daily", maxHours: 10 }],
    // Plain names, not objects — unlike departments, which sit beside them in
    // the same payload and ARE objects. The asymmetry is easy to get wrong.
    certifications: ["Food Safety"],
    ...overrides,
  });
}

describe("create", () => {
  it("stores the JSON payloads", async () => {
    const t = await template("Restaurant");
    expect(t.departments).toEqual([{ name: "Kitchen" }]);
    expect(t.certifications).toEqual(["Food Safety"]);
  });

  it("defaults isAiGenerated to false", async () => {
    const t = await template("Restaurant");
    expect(t.isAiGenerated).toBe(false);
  });

  it("records an AI-generated template as such", async () => {
    const t = await template("Clinic", { isAiGenerated: true });
    expect(t.isAiGenerated).toBe(true);
  });

  it("starts active", async () => {
    const t = await template("Restaurant");
    expect(t.isActive).toBe(true);
  });

  it("refuses a duplicate name", async () => {
    await template("Restaurant");
    await expect(template("Restaurant")).rejects.toThrow();
  });
});

describe("findAll vs findActive", () => {
  beforeEach(async () => {
    await template("Restaurant");
    const retired = await template("Retail");
    await repo.deactivate(retired.id);
  });

  it("findAll includes deactivated templates, for platform admin", async () => {
    expect(await repo.findAll()).toHaveLength(2);
  });

  it("findActive hides them, for onboarding", async () => {
    const active = await repo.findActive();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("Restaurant");
  });

  it("both order oldest first, so the list is stable between page loads", async () => {
    const all = await repo.findAll();
    expect(all.map((t) => t.name)).toEqual(["Restaurant", "Retail"]);
  });
});

describe("findById and findByName", () => {
  it("finds by id", async () => {
    const t = await template("Restaurant");
    await expect(repo.findById(t.id)).resolves.toMatchObject({ name: "Restaurant" });
  });

  it("returns null for an unknown id", async () => {
    await expect(repo.findById("no-such-template")).resolves.toBeNull();
  });

  it("finds by name, for the uniqueness check before create", async () => {
    await template("Restaurant");
    await expect(repo.findByName("Restaurant")).resolves.not.toBeNull();
  });

  it("is case sensitive on name", async () => {
    // Worth knowing rather than assuming: "restaurant" and "Restaurant" are two
    // different templates as far as the unique constraint is concerned.
    await template("Restaurant");
    await expect(repo.findByName("restaurant")).resolves.toBeNull();
  });
});

describe("update", () => {
  it("changes only the fields given", async () => {
    const t = await template("Restaurant");
    const updated = await repo.update(t.id, { description: "Updated copy" });

    expect(updated.description).toBe("Updated copy");
    expect(updated.name).toBe("Restaurant");
    expect(updated.icon).toBe("utensils");
  });

  it("replaces a JSON payload wholesale rather than merging", async () => {
    const t = await template("Restaurant");
    const updated = await repo.update(t.id, { departments: [{ name: "Bar" }] });

    expect(updated.departments).toEqual([{ name: "Bar" }]);
  });
});

describe("deactivate and activate", () => {
  it("deactivate is a soft delete — the row survives", async () => {
    const t = await template("Restaurant");
    await repo.deactivate(t.id);

    await expect(repo.findById(t.id)).resolves.not.toBeNull();
    expect(await repo.findActive()).toHaveLength(0);
  });

  it("activate brings it back", async () => {
    const t = await template("Restaurant");
    await repo.deactivate(t.id);
    await repo.activate(t.id);

    expect(await repo.findActive()).toHaveLength(1);
  });
});

describe("usage counts", () => {
  it("counts organisations created from a template", async () => {
    const t = await template("Restaurant");
    const tenant = await createTenant("tmpl");
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { templateId: t.id },
    });

    await expect(repo.getUsageCount(t.id)).resolves.toBe(1);
  });

  it("is zero for an unused template", async () => {
    const t = await template("Restaurant");
    await expect(repo.getUsageCount(t.id)).resolves.toBe(0);
  });

  it("getUsageCounts returns a map keyed by template id", async () => {
    const used = await template("Restaurant");
    await template("Retail");
    const tenant = await createTenant("tmpl");
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { templateId: used.id },
    });

    const counts = await repo.getUsageCounts();
    expect(counts[used.id]).toBe(1);
  });

  it("omits templates nobody used rather than reporting them as zero", async () => {
    // The caller reads `counts[id] ?? 0`, so absent and zero mean the same —
    // pinned so a future rewrite to `counts[id]` alone does not print undefined.
    const unused = await template("Retail");
    const counts = await repo.getUsageCounts();

    expect(counts[unused.id]).toBeUndefined();
  });

  it("ignores organisations with no template", async () => {
    await createTenant("plain");
    const counts = await repo.getUsageCounts();
    expect(Object.keys(counts)).toHaveLength(0);
  });
});
