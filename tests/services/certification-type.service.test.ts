/**
 * The organisation's list of recognised certificates.
 *
 * ## The bug underneath all of this
 *
 * `Certification.name` is typed by the staff member. `Task.requiredCertifications`
 * is typed by the manager. `EligibilityService.checkCertifications` compares the
 * two by `trim().toLowerCase()` equality — and nothing ever brought the two
 * vocabularies together, so the app's own placeholder text disagreed with
 * itself: "e.g. Food Safety Level 2" on one screen, "e.g. Food Safety, RSA" on
 * the other. Follow both and the holder is silently ineligible for a shift they
 * are qualified for.
 *
 * ## What is worth testing here
 *
 * Not that rows can be written — that is Prisma's job. Three things:
 *
 *   1. case-insensitive uniqueness, which is STRICTER than the database index
 *      and has to be, because eligibility lower-cases before comparing
 *   2. the removal guard, which exists to stop a shift quietly losing a
 *      requirement the picker can no longer represent
 *
 * Filling the list from names already in use is NOT here. It is a data
 * migration, so it lives in the migration file and is tested against the real
 * statement in `tests/lib/certification-type-backfill.test.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CertificationTypeService } from "@/services/certification-type.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, createTask, type Tenant } from "../helpers/fixtures";

const service = new CertificationTypeService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("certtype");
});

/** A certificate held by the tenant's staff member, in the given state. */
async function held(name: string, status = "verified") {
  return prisma.certification.create({
    data: {
      membershipId: tenant.staff.membershipId,
      name,
      issuedDate: new Date("2026-01-01"),
      status,
    },
  });
}

/** A task requiring the given certificate names. */
async function requiring(...names: string[]) {
  const task = await createTask(tenant, `Shift needing ${names.join(", ")}`);
  return prisma.task.update({
    where: { id: task.id },
    data: { requiredCertifications: names },
  });
}

describe("adding a name", () => {
  it("stores it trimmed", async () => {
    const type = await service.create(tenant.orgId, "  Food Safety  ");
    expect(type.name).toBe("Food Safety");
  });

  it("refuses an empty name", async () => {
    await expect(service.create(tenant.orgId, "   ")).rejects.toThrow(
      "A certificate name is required"
    );
  });

  it("refuses the same name twice", async () => {
    await service.create(tenant.orgId, "RSA");

    await expect(service.create(tenant.orgId, "RSA")).rejects.toThrow(
      "already on the list"
    );
  });

  /*
   * Stricter than the unique index, which Postgres applies case-sensitively.
   * Eligibility lower-cases both sides before comparing, so "Food Safety" and
   * "food safety" are one certificate — admitting both would put a choice in
   * front of a manager where there is only one thing to choose.
   */
  it("refuses one that differs only in case", async () => {
    await service.create(tenant.orgId, "Food Safety");

    await expect(
      service.create(tenant.orgId, "food safety")
    ).rejects.toThrow("already on the list");
  });

  it("refuses one that differs only in surrounding space", async () => {
    await service.create(tenant.orgId, "First Aid");

    await expect(service.create(tenant.orgId, " First Aid ")).rejects.toThrow(
      "already on the list"
    );
  });

  // Two organisations are two vocabularies. One using "RSA" must not stop
  // another from doing the same.
  it("lets a different organisation use the same name", async () => {
    const other = await createTenant("certtype-other");
    await service.create(tenant.orgId, "RSA");

    await expect(service.create(other.orgId, "RSA")).resolves.toBeDefined();
  });

  it("lists them alphabetically", async () => {
    await service.create(tenant.orgId, "RSA");
    await service.create(tenant.orgId, "First Aid");
    await service.create(tenant.orgId, "Food Safety");

    const names = (await service.list(tenant.orgId)).map((t) => t.name);
    expect(names).toEqual(["First Aid", "Food Safety", "RSA"]);
  });

  it("does not list another organisation's", async () => {
    const other = await createTenant("certtype-other");
    await service.create(other.orgId, "Forklift");

    expect(await service.list(tenant.orgId)).toHaveLength(0);
  });
});

/**
 * Removal.
 *
 * Removing a type deletes nothing: the requirement is a stored string on the
 * task and eligibility keeps enforcing it. What breaks is quieter — the task
 * form offers only names on this list, so opening that shift to change its
 * start time and saving would drop a requirement it can no longer represent. A
 * shift that silently stops checking for a food-safety certificate is the
 * failure this whole change exists to prevent, arriving by a different door.
 */
describe("removing a name", () => {
  it("removes one nothing requires", async () => {
    const type = await service.create(tenant.orgId, "Forklift");

    await service.remove(type.id, tenant.orgId);

    expect(await service.list(tenant.orgId)).toHaveLength(0);
  });

  it("refuses while a task still requires it", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    await requiring("Food Safety");

    await expect(service.remove(type.id, tenant.orgId)).rejects.toThrow(
      "Cannot remove:"
    );
  });

  // The count is the actionable part — one stale shift and half the roster are
  // very different decisions, and names would be unreadable at task scale.
  it("says how many tasks stand in the way", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    await requiring("Food Safety");
    await requiring("Food Safety", "RSA");

    await expect(service.remove(type.id, tenant.orgId)).rejects.toThrow(
      /2 tasks still require/
    );
  });

  it("uses the singular for one", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    await requiring("Food Safety");

    await expect(service.remove(type.id, tenant.orgId)).rejects.toThrow(
      /1 task still requires/
    );
  });

  /*
   * The requirement is matched case-insensitively everywhere else, so the guard
   * has to be too. A task requiring "food safety" is requiring this
   * certificate, and letting the entry be removed because the letters differ
   * would be the guard failing in exactly the case it exists for.
   */
  it("still refuses when the task spells it differently", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    await requiring("food safety");

    await expect(service.remove(type.id, tenant.orgId)).rejects.toThrow(
      "Cannot remove:"
    );
  });

  // A member HOLDING it is not a reason to refuse. Their record keeps the name
  // either way, and nothing about it stops working.
  it("does not count members who hold it", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    await held("Food Safety");

    await expect(service.remove(type.id, tenant.orgId)).resolves.toBeDefined();
  });

  it("refuses another organisation's", async () => {
    const other = await createTenant("certtype-other");
    const type = await service.create(other.orgId, "Forklift");

    await expect(service.remove(type.id, tenant.orgId)).rejects.toThrow(
      "Certificate not found"
    );
  });

  it("leaves it in place when it refuses", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    await requiring("Food Safety");

    await service.remove(type.id, tenant.orgId).catch(() => {});

    expect(await service.list(tenant.orgId)).toHaveLength(1);
  });
});
