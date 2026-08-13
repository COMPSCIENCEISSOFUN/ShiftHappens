/**
 * Saying "the engine did not answer" rather than answering for it.
 *
 * Three surfaces reported an AI failure as an ordinary, uneventful result:
 *
 *  - the feedback-themes panel printed "Nothing recurring in what people
 *    wrote", an affirmative claim that the text WAS read, while both providers
 *    had failed. That panel has since been removed for an unrelated reason —
 *    it was being handed the decline reason and read the enum back as a theme —
 *    so only its lesson survives here;
 *  - the priority call returned `{ call: null }` for five different situations,
 *    so the badge vanished identically whether the engine had no strong opinion
 *    or had stopped answering a fortnight ago;
 *  - template generation told the user to "try describing your business
 *    differently" after a rate limit — sending them to rewrite prose that was
 *    never the problem, and which would fail identically.
 *
 * None of these lost data. All of them made a failure look like a finding,
 * which is the harder kind of bug to notice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { AIDashboardService } from "@/services/ai-dashboard.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const dashboard = new AIDashboardService();

let tenant: Tenant;

/** Both providers configured but refusing — the live 429 case. */
function providersRefusing() {
  process.env.GROQ_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("rate limited", { status: 429 }))
  );
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("unavailable");
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("the priority call", () => {
  /** Two alerts with entity ids — the minimum before the engine is asked. */
  async function seedAlerts() {
    for (let i = 0; i < 3; i++) {
      await prisma.certification.create({
        data: {
          membershipId: tenant.staff.membershipId,
          name: `Cert ${i}`,
          issuedDate: new Date(Date.now() - 400 * 86_400_000),
          expiryDate: new Date(Date.now() + 5 * 86_400_000),
          status: "verified",
        },
      });
    }
  }

  it("marks itself unavailable when no provider answered", async () => {
    await seedAlerts();
    providersRefusing();

    const result = await dashboard.getPriorityCall(tenant.orgId);

    /*
     * Strict. The first draft of this asserted `unavailable === true ||
     * unavailable === undefined`, which is satisfied by every possible value
     * and could not fail — the same shape of useless test this session has
     * already produced twice. The fixture seeds three expiring certifications,
     * which is above the two-alert threshold, so the engine IS asked and the
     * flag must be set.
     *
     * `call` used to be asserted null here, and that is the half that changed
     * on 2026-08-10. A provider outage now falls back to the most severe alert,
     * chosen by rule — every other AI surface in the product degrades, and this
     * one went blank beside a list that had already ranked the same alerts.
     *
     * `unavailable` is the assertion that must NOT weaken. It is what keeps a
     * fortnight of outage from reading as a fortnight of ordinary advice, and
     * it is now the only thing distinguishing the two.
     */
    expect(result.unavailable).toBe(true);
    expect(result.call).not.toBeNull();
    expect(result.call!.provider).toBe("algorithmic");
    // No sentence, because there is nobody to write one. A `reason` here would
    // be prose this codebase invented and attributed to an engine that was
    // unreachable.
    expect(result.call!.reason).toBeNull();
  });

  /*
   * Nothing worth prioritising is not a failure, and must not be reported as
   * one — otherwise the note appears on every quiet dashboard and stops
   * meaning anything.
   */
  it("does not claim unavailable when there was nothing to prioritise", async () => {
    const result = await dashboard.getPriorityCall(tenant.orgId);

    expect(result.call).toBeNull();
    expect(result.unavailable).toBeFalsy();
  });
});
