// @vitest-environment jsdom
/**
 * The plan context, and the one part of it that is not obvious.
 *
 * Feature availability is a pure lookup and would barely be worth a test on its
 * own. `atLimit` is not: it has THREE inputs where it looks like two, because
 * the usage count is fetched and is therefore unknown for the first moment of
 * every page. What it answers during that moment decides whether every create
 * button in the product flickers.
 *
 * The choice is to answer false. A button that starts disabled and enables
 * itself a beat later is worse than one that is briefly optimistic: the server
 * refuses either way, with a message naming the limit and the upgrade, whereas
 * a control that changes under the cursor is a bug the reader has to interpret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PlanProvider, usePlan } from "@/components/layout/plan-provider";

/** Prints one answer per line so a test can assert on exactly what it asked. */
function Probe() {
  const plan = usePlan();
  return (
    <ul>
      <li data-testid="tier">{plan.tier}</li>
      <li data-testid="tier-name">{plan.tierName}</li>
      <li data-testid="custom-roles">{String(plan.has("custom_roles"))}</li>
      <li data-testid="audit">{String(plan.has("audit_log"))}</li>
      {/* The Enterprise-only probe. `audit_log` held this job until it moved
          to Pro on 2026-08-11, and the test below needs a feature that still
          answers differently at Pro than at Enterprise. */}
      <li data-testid="top-tier">{String(plan.has("priority_support"))}</li>
      <li data-testid="needs">{plan.requiredTier("priority_support")}</li>
      <li data-testid="limit">{String(plan.limitFor("members"))}</li>
      <li data-testid="usage">{String(plan.usageOf("members"))}</li>
      <li data-testid="at-limit">{String(plan.atLimit("members"))}</li>
    </ul>
  );
}

function value(id: string) {
  return screen.getByTestId(id).textContent;
}

/** The subscription endpoint, answering with a member count. */
function mockUsage(members: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resources: { members: { current: members, limit: null, percentage: null } },
      }),
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the plan includes", () => {
  it("answers from the tier, before anything is fetched", () => {
    // No fetch stubbed at all: feature availability must not wait on one.
    render(
      <PlanProvider tier="enterprise">
        <Probe />
      </PlanProvider>
    );

    expect(value("custom-roles")).toBe("true");
    expect(value("audit")).toBe("true");
    expect(value("top-tier")).toBe("true");
  });

  it("refuses everything on the lowest tier", () => {
    render(
      <PlanProvider tier="free">
        <Probe />
      </PlanProvider>
    );

    expect(value("custom-roles")).toBe("false");
    expect(value("audit")).toBe("false");
    expect(value("top-tier")).toBe("false");
  });

  /*
   * Pro is the tier worth pinning: it is the one where gated features give
   * DIFFERENT answers, so a check that returned the same value for every
   * feature would pass on Free and Enterprise alone and prove nothing.
   *
   * The pair changed on 2026-08-11 when `audit_log` moved down to Pro. The
   * test is not about the audit log — it is about the boundary existing — so
   * it now uses `priority_support`, which is what remains above Pro. Kept
   * rather than deleted for that reason.
   */
  it("separates the two tiers of feature on Pro", () => {
    render(
      <PlanProvider tier="pro">
        <Probe />
      </PlanProvider>
    );

    expect(value("custom-roles")).toBe("true");
    expect(value("audit")).toBe("true");
    expect(value("top-tier")).toBe("false");
  });

  it("names the plan a locked feature needs", () => {
    render(
      <PlanProvider tier="free">
        <Probe />
      </PlanProvider>
    );

    // Still enterprise, but now for `priority_support` rather than the audit
    // log — `requiredTier` names a plan, so its subject had to move with it.
    expect(value("needs")).toBe("enterprise");
  });
});

describe("the limit, before and after the count arrives", () => {
  it("reports usage as unknown until the request answers", () => {
    // A promise that never settles — the first render, held still.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(
      <PlanProvider orgId="org1" tier="free">
        <Probe />
      </PlanProvider>
    );

    expect(value("usage")).toBe("null");
    expect(value("at-limit")).toBe("false");
  });

  it("says nothing is full while the count is unknown, even at a low cap", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(
      <PlanProvider orgId="org1" tier="free">
        <Probe />
      </PlanProvider>
    );

    expect(value("limit")).toBe("10");
    expect(value("at-limit")).toBe("false");
  });

  it("reports the cap reached once the count arrives", async () => {
    mockUsage(10);
    render(
      <PlanProvider orgId="org1" tier="free">
        <Probe />
      </PlanProvider>
    );

    await waitFor(() => expect(value("usage")).toBe("10"));
    expect(value("at-limit")).toBe("true");
  });

  // At, not near. Nine of ten is not full, and an off-by-one here would block
  // the last member of every Free organisation.
  it("leaves one below the cap alone", async () => {
    mockUsage(9);
    render(
      <PlanProvider orgId="org1" tier="free">
        <Probe />
      </PlanProvider>
    );

    await waitFor(() => expect(value("usage")).toBe("9"));
    expect(value("at-limit")).toBe("false");
  });

  // Over the cap is reachable: a plan can be downgraded with the members
  // already in place, and `>=` is what makes that read as full rather than as
  // room to spare.
  it("treats over the cap as full", async () => {
    mockUsage(14);
    render(
      <PlanProvider orgId="org1" tier="free">
        <Probe />
      </PlanProvider>
    );

    await waitFor(() => expect(value("usage")).toBe("14"));
    expect(value("at-limit")).toBe("true");
  });

  it("is never full on an unlimited plan", async () => {
    mockUsage(4000);
    render(
      <PlanProvider orgId="org1" tier="enterprise">
        <Probe />
      </PlanProvider>
    );

    await waitFor(() => expect(value("usage")).toBe("4000"));
    expect(value("limit")).toBe("null");
    expect(value("at-limit")).toBe("false");
  });

  /*
   * A failed usage request must not disable anything. The count is a courtesy;
   * the refusal that matters is the server's, and a create button that stopped
   * working because a secondary request failed would be a worse outcome than
   * one that lets the real answer come back.
   */
  it("stays permissive when the count cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(
      <PlanProvider orgId="org1" tier="free">
        <Probe />
      </PlanProvider>
    );

    await waitFor(() => expect(value("at-limit")).toBe("false"));
    expect(value("usage")).toBe("null");
  });

  it("does not ask for usage when there is no organisation", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <PlanProvider tier="pro">
        <Probe />
      </PlanProvider>
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Outside the provider.
 *
 * The same argument `PermissionProvider` makes for denying everything by
 * default: a wiring mistake should show the most restricted plan, not the
 * least. Unlocking the product because a provider was forgotten is the one
 * failure mode worth designing against.
 */
describe("with no provider above it", () => {
  it("answers as the free tier", () => {
    render(<Probe />);

    expect(value("tier")).toBe("free");
    expect(value("custom-roles")).toBe("false");
    expect(value("audit")).toBe("false");
  });

  it("still blocks nothing, since it knows no counts", () => {
    render(<Probe />);

    expect(value("usage")).toBe("null");
    expect(value("at-limit")).toBe("false");
  });
});
