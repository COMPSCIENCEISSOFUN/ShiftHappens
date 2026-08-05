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

  /*
   * The order has to survive a TIE, which is the case the assertion above
   * cannot reach on its own.
   *
   * Prisma maps `DateTime` to `timestamp(3)`, so two rows created in the same
   * millisecond carry the same `createdAt` — and Postgres gives no defined
   * order for ties, so `ORDER BY createdAt` alone can return them either way
   * round on successive calls. Whether that happens depends on how fast the
   * machine is: this passed on a slow one, where the two creates landed 50ms
   * apart, and failed on a fast one where they did not.
   *
   * Forcing the timestamps equal makes the tiebreak the only thing deciding,
   * so the test asserts the property rather than the timing.
   */
  it("stays in the same order when two rows share a timestamp", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    await prisma.industryTemplate.updateMany({ data: { createdAt: stamp } });

    /*
     * Equal timestamps alone are not enough to expose the fault: with two rows
     * Postgres seq-scans and returns heap order, which happens to match
     * insertion order, so a missing tiebreak still looks right.
     *
     * UPDATING the first row is what makes it observable. Postgres has no
     * in-place update — the new tuple is appended to the end of the heap — so
     * after this, a scan returns Retail before Restaurant. Without a tiebreak
     * the list silently flips; with one it does not. This is not a contrived
     * scenario: editing a template is an ordinary admin action.
     */
    await repo.update(
      (await repo.findByName("Restaurant"))!.id,
      { description: "Edited" }
    );
    await prisma.industryTemplate.updateMany({ data: { createdAt: stamp } });

    const first = await repo.findAll();
    const second = await repo.findAll();

    expect(first.map((t) => t.createdAt.getTime())).toEqual([
      stamp.getTime(),
      stamp.getTime(),
    ]);
    // Stable across calls…
    expect(first.map((t) => t.id)).toEqual(second.map((t) => t.id));
    // …and still oldest-created first, because the cuid tiebreak agrees.
    expect(first.map((t) => t.name)).toEqual(["Restaurant", "Retail"]);
  });

  it("applies the same tiebreak to findActive", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    await repo.activate((await repo.findByName("Retail"))!.id);
    // Same heap-reorder trick as above — see the comment there.
    await repo.update(
      (await repo.findByName("Restaurant"))!.id,
      { description: "Edited" }
    );
    await prisma.industryTemplate.updateMany({ data: { createdAt: stamp } });

    const first = await repo.findActive();
    const second = await repo.findActive();
    expect(first.map((t) => t.id)).toEqual(second.map((t) => t.id));
    expect(first.map((t) => t.name)).toEqual(["Restaurant", "Retail"]);
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
