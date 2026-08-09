/**
 * The data half of the certificate-type migration, run as SQL.
 *
 * ## Why this is in the migration and not in a script
 *
 * Filling the list from the names already in use is a DATA MIGRATION: it has to
 * happen once per database, at the moment the table appears, before anybody
 * edits a task. A shift requiring "Food Safety" cannot show that requirement
 * until the name is on the list, and saving it in the meantime drops the
 * requirement silently.
 *
 * "Once per database, at the moment the table appears" is the definition of a
 * migration step. A script alongside it is a second thing to remember, on a
 * different schedule, needing a production connection string on somebody's
 * laptop; a button in the UI is a one-time job wearing a permanent feature's
 * clothes. Both were considered and both are worse than putting the statement
 * in the file that creates the table, where it runs in the same transaction and
 * cannot be forgotten.
 *
 * ## Why it is tested at all
 *
 * Migration SQL is usually written once and trusted, which is exactly why it is
 * worth testing here: this statement carries four rules that are easy to get
 * wrong and impossible to notice afterwards — both sources, blanks dropped,
 * case-insensitive collapse, and org scoping. Getting the third wrong would
 * produce two entries for one certificate, which is the ambiguity the whole
 * table exists to remove, introduced at the moment it is created.
 *
 * The statement is read from the migration file rather than copied, so this
 * cannot drift from what actually runs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, createTask, type Tenant } from "../helpers/fixtures";

const MIGRATION = readFileSync(
  "prisma/migrations/20260808120000_certification_type/migration.sql",
  "utf8"
);

/**
 * The INSERT, lifted out of the migration by its marker comment.
 *
 * The CREATE TABLE above it cannot be re-run against a database that already
 * has the table, so the file is split rather than replayed whole.
 */
const BACKFILL = MIGRATION.split("-- >>> BACKFILL")[1];

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("backfill");
});

async function runBackfill() {
  await prisma.$executeRawUnsafe(BACKFILL);
}

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

async function requiring(...names: string[]) {
  const task = await createTask(tenant, `Shift ${names.join("-")}`);
  return prisma.task.update({
    where: { id: task.id },
    data: { requiredCertifications: names },
  });
}

/** The names now on the organisation's list. */
async function listed(organizationId = tenant.orgId) {
  const rows = await prisma.certificationType.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => r.name);
}

describe("the migration finds the names already in use", () => {
  it("is present in the migration file at all", () => {
    // A marker that vanished would leave this suite testing an empty string,
    // which every assertion below would pass.
    expect(BACKFILL).toBeTruthy();
    expect(BACKFILL).toMatch(/INSERT INTO "CertificationType"/);
  });

  it("takes the names members hold", async () => {
    await held("Food Safety");
    await held("RSA");

    await runBackfill();

    expect(await listed()).toEqual(["Food Safety", "RSA"]);
  });

  /*
   * The half that would silently lose data. A member's certificate going
   * unlisted is an inconvenience; a TASK's requirement going unlisted is a
   * requirement that disappears the next time that shift is saved.
   */
  it("takes the names tasks require", async () => {
    await requiring("First Aid", "Food Safety");

    await runBackfill();

    expect(await listed()).toEqual(["First Aid", "Food Safety"]);
  });

  it("takes both without duplicating the overlap", async () => {
    await held("Food Safety");
    await requiring("Food Safety", "RSA");

    await runBackfill();

    expect(await listed()).toEqual(["Food Safety", "RSA"]);
  });

  /*
   * Two spellings of one certificate must become ONE entry. Eligibility
   * lower-cases before comparing, so admitting both would offer a manager two
   * ways to require the same thing — the exact ambiguity this table removes,
   * recreated at the moment it is populated.
   */
  it("collapses spellings that differ only in case", async () => {
    await held("Food Safety");
    await requiring("food safety");

    await runBackfill();

    expect(await listed()).toHaveLength(1);
  });

  it("trims surrounding space rather than storing two of them", async () => {
    await held("  RSA  ");
    await requiring("RSA");

    await runBackfill();

    expect(await listed()).toEqual(["RSA"]);
  });

  it("drops blank and whitespace-only names", async () => {
    await requiring("   ", "RSA");

    await runBackfill();

    expect(await listed()).toEqual(["RSA"]);
  });

  // Pending and rejected count: the question is which words are in use, not
  // which are currently valid. Somebody will need to pick that name again.
  it("takes a name from a certificate awaiting verification", async () => {
    await held("Forklift", "pending");

    await runBackfill();

    expect(await listed()).toEqual(["Forklift"]);
  });

  it("keeps each organisation's vocabulary to itself", async () => {
    const other = await createTenant("backfill-other");
    await held("Food Safety");
    await prisma.certification.create({
      data: {
        membershipId: other.staff.membershipId,
        name: "Forklift",
        issuedDate: new Date("2026-01-01"),
        status: "verified",
      },
    });

    await runBackfill();

    expect(await listed()).toEqual(["Food Safety"]);
    expect(await listed(other.orgId)).toEqual(["Forklift"]);
  });

  // The same name in two organisations is two entries, not a conflict — the
  // unique index is on the pair.
  it("gives two organisations the same name separately", async () => {
    const other = await createTenant("backfill-other");
    await held("RSA");
    await prisma.certification.create({
      data: {
        membershipId: other.staff.membershipId,
        name: "RSA",
        issuedDate: new Date("2026-01-01"),
        status: "verified",
      },
    });

    await runBackfill();

    expect(await listed()).toEqual(["RSA"]);
    expect(await listed(other.orgId)).toEqual(["RSA"]);
  });

  it("does nothing where there is nothing to find", async () => {
    await runBackfill();

    expect(await listed()).toEqual([]);
  });
});

/**
 * Re-running it.
 *
 * Not a theoretical concern. `db push` does not run migration files, so on a
 * developer machine this statement is applied by hand — and the demo seed
 * writes the same rows from the same data. Both paths have to be able to meet
 * without a unique-constraint violation taking the migration down.
 */
describe("running it twice", () => {
  it("adds nothing the second time", async () => {
    await held("Food Safety");
    await requiring("RSA");

    await runBackfill();
    await runBackfill();

    expect(await listed()).toEqual(["Food Safety", "RSA"]);
  });

  it("does not collide with a name that is already listed", async () => {
    await prisma.certificationType.create({
      data: { organizationId: tenant.orgId, name: "Food Safety" },
    });
    await held("Food Safety");

    await expect(runBackfill()).resolves.not.toThrow();
    expect(await listed()).toEqual(["Food Safety"]);
  });

  /*
   * A listed entry differing only in CASE from one in use. `ON CONFLICT` is
   * case-sensitive, so it cannot catch this — the collapse has to have already
   * happened, and it has not, because the existing row was written by
   * something else.
   *
   * Recorded rather than solved: it needs a case-insensitive unique index,
   * which is a second migration for a case that arises only if somebody adds a
   * name by hand between the table being created and this statement running,
   * inside one transaction. `CertificationTypeService.create` refuses it on
   * every path a person can actually reach.
   */
  it("can admit a differently-cased duplicate of a hand-added entry", async () => {
    await prisma.certificationType.create({
      data: { organizationId: tenant.orgId, name: "Food Safety" },
    });
    await held("FOOD SAFETY");

    await runBackfill();

    expect(await listed()).toHaveLength(2);
  });
});
