/**
 * Ordering that does not depend on luck.
 *
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AuditLogRepository } from "@/repositories/audit-log.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const auditRepo = new AuditLogRepository();

describe("no repository orders by createdAt alone", () => {
  const REPOSITORIES = join(process.cwd(), "src", "repositories");

  it("finds no single-key createdAt ordering", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(REPOSITORIES).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(REPOSITORIES, file), "utf8");
      source.split("\n").forEach((line, i) => {
        if (/orderBy:\s*\{\s*createdAt:\s*"(asc|desc)"\s*\}/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }

    // If this fails, add `{ id }` as a second key in the direction createdAt
    // already uses: orderBy: [{ createdAt: "desc" }, { id: "desc" }].
    expect(offenders).toEqual([]);
  });
});

describe("rows sharing a timestamp", () => {
  let tenant: Tenant;

  beforeEach(async () => {
    await cleanDatabase();
    tenant = await createTenant("ordering");
  });

  /*
   * Written with an identical `createdAt` rather than hoping two inserts land
   * in the same millisecond. Racing the clock is what made the original bug
   * machine-dependent, and a test that only fails on fast hardware is a test
   * that passes in review.
   */
  async function logAt(action: string, createdAt: Date) {
    return prisma.auditLog.create({
      data: {
        organizationId: tenant.orgId,
        userId: tenant.admin.userId,
        action,
        entityType: "task",
        createdAt,
      },
    });
  }

  /*
   * There is deliberately no "returns the same order on three consecutive
   * queries" test here. One was written and deleted: with the fix reverted it
   * still passed, because a small table with a fresh plan happens to come back
   * consistently — undefined order is not the same as varying order, and
   * asserting the observable symptom cannot catch the defect. What CAN be
   * asserted is that the order is the one the code specifies, which is below.
   */
  it("breaks the tie on id, in the direction createdAt already sorts", async () => {
    const sameInstant = new Date("2026-08-01T09:00:00.000Z");
    const a = await logAt("first", sameInstant);
    const b = await logAt("second", sameInstant);
    const c = await logAt("third", sameInstant);

    const rows = await auditRepo.findByOrganizationId(tenant.orgId);
    const tied = rows.filter((r) => r.createdAt.getTime() === sameInstant.getTime());

    expect(tied.map((r) => r.id)).toEqual(
      [a.id, b.id, c.id].sort().reverse()
    );
  });

  // The tiebreak must not disturb the ordering that was already correct.
  it("still puts a newer row first", async () => {
    const older = await logAt("older", new Date("2026-08-01T09:00:00.000Z"));
    const newer = await logAt("newer", new Date("2026-08-01T10:00:00.000Z"));

    const rows = await auditRepo.findByOrganizationId(tenant.orgId);
    const positions = rows.map((r) => r.id);

    expect(positions.indexOf(newer.id)).toBeLessThan(positions.indexOf(older.id));
  });
});
