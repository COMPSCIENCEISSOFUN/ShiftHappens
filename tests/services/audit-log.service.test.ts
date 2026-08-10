/**
 * Audit logging — the fire-and-forget guarantee.
 *
 * `log()` is called from roughly twenty services, always after the operation it
 * records has already succeeded. If it ever throws, the caller's `await` rejects
 * and a task that WAS created reports as failed. That property is one try/catch
 * with nothing behind it, so it is pinned here from both sides: a real database
 * rejection, and a stubbed one.
 *
 * Filter and pagination mechanics live in the repository test; what is asserted
 * here is that the service passes them through and reports the envelope the
 * audit-log page paginates on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { AuditLogRepository } from "@/repositories/audit-log.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const auditService = new AuditLogService();

let tenant: Tenant;
let other: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("audit");
  other = await createTenant("oth");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function silenceConsole() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("log", () => {
  /**
   * Inverted, and the reason is worth more than the test.
   *
   * This passed `ipAddress: "203.0.113.4"` and asserted it came back — proving
   * the plumbing worked end to end. **It was the only thing in the codebase
   * that ever passed one.** The column was optional at the schema, the
   * repository and the service, so no production caller had to supply one and
   * none did; every real row's `ipAddress` has been null since the table was
   * created, and this test reported the field as working the whole time.
   *
   * A test that a value SAVES is not a test that anything writes it. The
   * parameter is gone from the service and the repository; the column follows
   * in the next migration that touches this table, because dropping one needs
   * the deploy that stops referencing it to go out first (§4).
   *
   * Retired on cost, not on impossibility — `getClientIp` in `src/middleware.ts`
   * resolves an address correctly today and is tested. See the note on
   * `AuditLogRepository.create` for why that is not the same as being able to
   * record one here.
   */
  it("writes the entry, and records no address for it", async () => {
    await auditService.log({
      organizationId: tenant.orgId,
      userId: tenant.admin.userId,
      action: ACTIONS.TASK_CREATED,
      entityType: "task",
      entityId: "task-1",
      details: { title: "Evening shift" },
    });

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: tenant.orgId },
    });
    expect(log).toMatchObject({
      action: "task.created",
      entityType: "task",
      entityId: "task-1",
      userId: tenant.admin.userId,
    });
    expect(log.details).toEqual({ title: "Evening shift" });
    /*
     * Asserted, not ignored. While the column exists it must be honestly empty
     * rather than quietly half-populated — a log with an address on some rows
     * and not others is worse than one with none, because it invites the reader
     * to infer something from the gap.
     */
    expect(log.ipAddress).toBeNull();
  });

  it("writes with only the required fields", async () => {
    await auditService.log({
      organizationId: tenant.orgId,
      action: ACTIONS.SETTINGS_UPDATED,
      entityType: "settings",
    });

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: tenant.orgId },
    });
    expect(log.userId).toBeNull();
    expect(log.entityId).toBeNull();
  });

  it("does not throw when the database rejects the write", async () => {
    // A userId with no matching row — a foreign key violation from the real
    // database, not a stub. This is what a stale session id would produce.
    const consoleError = silenceConsole();

    await expect(
      auditService.log({
        organizationId: tenant.orgId,
        userId: "no-such-user",
        action: ACTIONS.TASK_CREATED,
        entityType: "task",
      })
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
  });

  it("does not throw when the repository itself fails", async () => {
    const consoleError = silenceConsole();
    vi.spyOn(AuditLogRepository.prototype, "create").mockRejectedValue(
      new Error("connection lost")
    );

    await expect(
      auditService.log({
        organizationId: tenant.orgId,
        action: ACTIONS.MEMBER_INVITED,
        entityType: "member",
      })
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith("[AuditLog Error]", expect.any(Error));
  });

  it("records nothing when the write failed", async () => {
    silenceConsole();

    await auditService.log({
      organizationId: "no-such-org",
      action: ACTIONS.TASK_CREATED,
      entityType: "task",
    });

    await expect(prisma.auditLog.count()).resolves.toBe(0);
  });

  it("swallows a synchronous repository throw, not just a rejection", async () => {
    // `create` is async today. If someone refactors it to validate before the
    // await, a throw would escape a try/catch that only handled rejections.
    silenceConsole();
    vi.spyOn(AuditLogRepository.prototype, "create").mockImplementation(() => {
      throw new Error("bad arguments");
    });

    await expect(
      auditService.log({
        organizationId: tenant.orgId,
        action: ACTIONS.ROLE_CREATED,
        entityType: "role",
      })
    ).resolves.toBeUndefined();
  });
});

describe("getLogs", () => {
  async function seed(count: number, overrides: Record<string, unknown> = {}) {
    for (let i = 0; i < count; i++) {
      await prisma.auditLog.create({
        data: {
          organizationId: tenant.orgId,
          action: "task.created",
          entityType: "task",
          ...overrides,
        },
      });
    }
  }

  it("returns logs alongside the total and the paging window", async () => {
    await seed(3);
    const result = await auditService.getLogs(tenant.orgId);

    expect(result.logs).toHaveLength(3);
    expect(result).toMatchObject({ total: 3, limit: 50, offset: 0 });
  });

  it("reports the total unfiltered by the page size", async () => {
    // The page renders "showing 2 of 5" from these two numbers, so `total` must
    // survive the take/skip that trims `logs`.
    await seed(5);
    const result = await auditService.getLogs(tenant.orgId, undefined, 2, 0);

    expect(result.logs).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it("echoes back the limit and offset it was given", async () => {
    await seed(5);
    const result = await auditService.getLogs(tenant.orgId, undefined, 2, 2);

    expect(result).toMatchObject({ limit: 2, offset: 2 });
    expect(result.logs).toHaveLength(2);
  });

  it("counts against the same filter it queries with", async () => {
    // Two calls, two copies of the filter — they can drift, and the symptom is
    // a pager offering pages that come back empty.
    await seed(2);
    await seed(3, { action: "task.deleted" });

    const result = await auditService.getLogs(tenant.orgId, { action: "task.deleted" }, 1, 0);
    expect(result.total).toBe(3);
    expect(result.logs[0].action).toBe("task.deleted");
  });

  it("filters by entity type and user", async () => {
    await seed(1, { entityType: "department", userId: tenant.admin.userId });
    await seed(1, { entityType: "task", userId: tenant.staff.userId });

    await expect(
      auditService.getLogs(tenant.orgId, { entityType: "department" })
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      auditService.getLogs(tenant.orgId, { userId: tenant.staff.userId })
    ).resolves.toMatchObject({ total: 1 });
  });

  it("filters by date range", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-06-01T00:00:00Z");
    await prisma.auditLog.create({
      data: { organizationId: tenant.orgId, action: "task.created", entityType: "task", createdAt: old },
    });
    await prisma.auditLog.create({
      data: { organizationId: tenant.orgId, action: "task.created", entityType: "task", createdAt: recent },
    });

    const result = await auditService.getLogs(tenant.orgId, {
      startDate: new Date("2026-03-01T00:00:00Z"),
      endDate: new Date("2026-09-01T00:00:00Z"),
    });
    expect(result.total).toBe(1);
    expect(result.logs[0].createdAt).toEqual(recent);
  });

  it("returns newest first", async () => {
    await prisma.auditLog.create({
      data: {
        organizationId: tenant.orgId,
        action: "task.created",
        entityType: "task",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: tenant.orgId,
        action: "task.deleted",
        entityType: "task",
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
    });

    const result = await auditService.getLogs(tenant.orgId);
    expect(result.logs.map((l) => l.action)).toEqual(["task.deleted", "task.created"]);
  });

  it("never returns another organisation's logs", async () => {
    await seed(2);
    await prisma.auditLog.create({
      data: { organizationId: other.orgId, action: "task.created", entityType: "task" },
    });

    const result = await auditService.getLogs(tenant.orgId);
    expect(result.total).toBe(2);
  });

  it("returns an empty page rather than throwing for an unknown organisation", async () => {
    const result = await auditService.getLogs("no-such-org");
    expect(result).toMatchObject({ logs: [], total: 0 });
  });
});

describe("ACTIONS", () => {
  it("has no duplicate values", async () => {
    // Two names mapping to one string would make the audit page's action filter
    // silently merge unrelated events.
    const values = Object.values(ACTIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses a dotted entity.verb form throughout", async () => {
    for (const value of Object.values(ACTIONS)) {
      expect(value).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
