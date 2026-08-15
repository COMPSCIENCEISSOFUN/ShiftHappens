/**
 * What actually reaches the audit log.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AuthService } from "@/services/auth.service";
import { ProfileService } from "@/services/profile.service";
import { PlatformService } from "@/services/platform.service";
import { CertificationService } from "@/services/certification.service";
import { ACTIONS } from "@/lib/audit-actions";
import { AUDIT_ENTITY_TYPES } from "@/lib/audit-entities";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { eventuallyAtLeast, pauseForAbsence } from "../helpers/settle";

const auth = new AuthService();
const profiles = new ProfileService();
const platform = new PlatformService();
const certs = new CertificationService();

let tenant: Tenant;

/** Entries of one action, whichever organisation they landed in. */
function entries(action: string) {
  return prisma.auditLog.findMany({ where: { action } });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("audit");
});

describe("account events, which have no organisation of their own", () => {
  /*
   * `AuditLog.organizationId` is required and a password reset happens outside
   * any organisation, so the event is written once per organisation the user is
   * an ACTIVE member of. That is the right audience rather than a workaround:
   * an admin whose rota depends on somebody has a legitimate interest in their
   * password changing.
   */
  it("records a password reset against the member's organisation", async () => {
    await prisma.passwordResetToken.create({
      data: {
        email: tenant.staff.email,
        token: "reset-token",
        expires: new Date(Date.now() + 3_600_000),
      },
    });

    await auth.resetPassword({
      token: "reset-token",
      password: "NewPass1!",
      confirmPassword: "NewPass1!",
    });

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.USER_PASSWORD_CHANGED)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(tenant.orgId);
    expect(rows[0].userId).toBe(tenant.staff.userId);
  });

  /*
   * A user in no organisation produces no rows, which is correct — there is
   * nobody to tell. The alternative would be an unreadable row against an
   * invented tenant.
   */
  it("writes nothing for a user who belongs to no organisation", async () => {
    const loner = await prisma.user.create({
      data: { name: "Loner", email: "loner@example.com", hashedPassword: "x" },
    });
    await prisma.passwordResetToken.create({
      data: {
        email: loner.email,
        token: "loner-token",
        expires: new Date(Date.now() + 3_600_000),
      },
    });

    await auth.resetPassword({
      token: "loner-token",
      password: "NewPass1!",
      confirmPassword: "NewPass1!",
    });

    expect(await entries(ACTIONS.USER_PASSWORD_CHANGED)).toHaveLength(0);
  });

  /*
   * An organisation somebody has LEFT has no claim on their account activity.
   * Dropping the `status: "active"` filter survived the first mutation pass —
   * every test used an active member, so none could notice a former employer
   * being told about a password change months after the fact.
   */
  it("does not tell an organisation the member has left", async () => {
    const former = await createTenant("former");
    await prisma.membership.create({
      data: {
        userId: tenant.staff.userId,
        organizationId: former.orgId,
        role: "staff",
        status: "inactive",
      },
    });

    await prisma.passwordResetToken.create({
      data: {
        email: tenant.staff.email,
        token: "left-token",
        expires: new Date(Date.now() + 3_600_000),
      },
    });

    await auth.resetPassword({
      token: "left-token",
      password: "NewPass1!",
      confirmPassword: "NewPass1!",
    });

    /*
     * Wait for the row that SHOULD arrive, then pause before asserting the one
     * that should not. `eventuallyAtLeast` returns on the first match, so on its
     * own it would have read the list before a second row could land — and this
     * assertion passed under mutation until the pause was added, which is
     * precisely the false PASS documented in helpers/settle.
     */
    await eventuallyAtLeast(() => entries(ACTIONS.USER_PASSWORD_CHANGED));
    await pauseForAbsence();

    const rows = await entries(ACTIONS.USER_PASSWORD_CHANGED);
    expect(rows.map((r) => r.organizationId)).toEqual([tenant.orgId]);
  });

  /*
   * A password change through the profile form is the same event as one through
   * the reset link, and must be findable the same way — an admin looking after
   * a suspected compromise should not have to know which door was used.
   */
  it("records a password change made from the profile page", async () => {
    const hashed = await import("bcryptjs").then((b) =>
      b.default.hash("OldPass1!", 12)
    );
    await prisma.user.update({
      where: { id: tenant.staff.userId },
      data: { hashedPassword: hashed },
    });

    await profiles.updateProfile(tenant.staff.userId, {
      currentPassword: "OldPass1!",
      newPassword: "NewPass1!",
    });

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.USER_PASSWORD_CHANGED)
    );
    expect(rows[0].organizationId).toBe(tenant.orgId);
  });

  /*
   * A name change is its own action, not folded into the password one. They
   * answer different questions, and burying a password change inside "profile
   * updated" would make it findable only by reading the details of every edit.
   */
  it("records a name change separately", async () => {
    await profiles.updateProfile(tenant.staff.userId, { name: "New Name" });

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.USER_PROFILE_UPDATED)
    );
    expect(rows).toHaveLength(1);
    expect(await entries(ACTIONS.USER_PASSWORD_CHANGED)).toHaveLength(0);
  });

  /*
   * The REQUEST is deliberately not logged. Anyone can raise one for any
   * address, so a log of requests records what strangers typed rather than what
   * happened to the account — and it would fill an admin's page with events no
   * member of their organisation caused.
   */
  it("does not record a reset request, only the change", async () => {
    await auth.requestPasswordReset(tenant.staff.email);

    expect(await entries(ACTIONS.USER_PASSWORD_CHANGED)).toHaveLength(0);
  });
});

describe("events that do have an organisation", () => {
  it("records a certificate being submitted", async () => {
    await certs.create(
      tenant.staff.membershipId,
      { name: "Food Safety", issuedDate: "2026-01-01T00:00:00.000Z" },
      { organizationId: tenant.orgId, userId: tenant.staff.userId }
    );

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.CERTIFICATION_SUBMITTED)
    );
    expect(rows[0].organizationId).toBe(tenant.orgId);
    expect((rows[0].details as { name: string }).name).toBe("Food Safety");
  });

  /*
   * Recorded against the AFFECTED tenant, not platform-side. Suspension stops
   * everyone in that organisation from doing anything, and the people it
   * happens to are the ones who need the record — a platform-side log would put
   * the account of the event out of reach of everybody affected by it.
   */
  it("records a platform admin suspending an organisation", async () => {
    await platform.toggleOrganizationStatus(tenant.orgId, tenant.admin.userId);

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.ORGANIZATION_SUSPENDED)
    );
    expect(rows[0].organizationId).toBe(tenant.orgId);
  });

  it("records reactivation as its own action", async () => {
    await platform.toggleOrganizationStatus(tenant.orgId, tenant.admin.userId);
    await platform.toggleOrganizationStatus(tenant.orgId, tenant.admin.userId);

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.ORGANIZATION_REACTIVATED)
    );
    expect(rows).toHaveLength(1);
  });

  // A plan change moves what the organisation can DO — audit access, custom
  // roles and export are all gated on it. An admin finding a feature gone
  // should be able to see it was a plan change rather than a fault.
  it("records a tier change", async () => {
    await platform.updateOrganizationTier(
      tenant.orgId,
      "pro",
      tenant.admin.userId
    );

    const rows = await eventuallyAtLeast(() =>
      entries(ACTIONS.ORGANIZATION_TIER_CHANGED)
    );
    expect((rows[0].details as { to: string }).to).toBe("pro");
  });
});

describe("the vocabulary cannot drift", () => {
  const SERVICES = join(process.cwd(), "src", "services");

  /*
   * Every action declared must be raised by something. Three were not —
   * `user.registered`, `user.logged_in` and `certification.submitted`. The
   * first two were deleted because neither can be scoped to a tenant; the third
   * was a genuine hole in an otherwise complete chain.
   *
   * This is the "built and uncalled" pattern that has now appeared seven times
   * in this codebase, caught for once by a test rather than by reading.
   */
  it("has no action that nothing raises", () => {
    const sources = readdirSync(SERVICES)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(SERVICES, f), "utf8"))
      .join("\n");

    const unused = Object.keys(ACTIONS).filter(
      (name) => !sources.includes(`ACTIONS.${name}`)
    );

    expect(unused).toEqual([]);
  });

  /*
   * And every entity type written must be one the filter offers, which the
   * union already guarantees at compile time — asserted here so the guarantee
   * is visible in the suite rather than only in the type checker, and so a
   * future `as AuditEntityType` cast cannot quietly reopen it.
   */
  it("writes only entity types the filter can reach", () => {
    const sources = readdirSync(SERVICES)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(SERVICES, f), "utf8"))
      .join("\n");

    const written = [
      ...new Set(
        [...sources.matchAll(/entityType:\s*"([a-z_-]+)"/g)].map((m) => m[1])
      ),
    ];
    const offered = new Set<string>(AUDIT_ENTITY_TYPES);

    expect(written.filter((w) => !offered.has(w))).toEqual([]);
    // A fixture that matched nothing would satisfy the line above.
    expect(written.length).toBeGreaterThan(8);
  });
});
