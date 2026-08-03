// @vitest-environment jsdom
/**
 * Platform admin pages — the first rendered-component tests in the suite.
 *
 * Everything else tests routes, services and repositories. These three pages
 * carry behaviour that lives nowhere else: what happens when a fetch fails,
 * whether a destructive action asks first, and whether a control reflects what
 * the database actually holds after a failed write. None of that is reachable
 * from the API layer, and all three were wrong here before the rewrite.
 *
 * `@testing-library/react` was already a dependency and had never been used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "@/app/(platform)/platform-admin/page";
import Organizations from "@/app/(platform)/platform-admin/organizations/page";
import Templates from "@/app/(platform)/platform-admin/templates/page";

/** Routes a stubbed fetch by URL. Later entries win on ties. */
function stubFetch(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const match = Object.keys(routes).find((key) => url.startsWith(key));
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

    const route = match ? routes[match] : undefined;
    if (!route) throw new Error(`No stub for ${url}`);

    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.body,
    } as Response;
  });

  vi.stubGlobal("fetch", impl);
  return calls;
}

const STATS = {
  totalOrganizations: 4,
  activeOrganizations: 3,
  totalUsers: 20,
  totalTasks: 55,
  tierCounts: { free: 2, pro: 1, enterprise: 1 },
};

function org(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    name: "Acme Diner",
    slug: "acme-diner",
    industry: "Food service",
    status: "active",
    subscriptionTier: "free",
    createdAt: "2026-01-15T00:00:00.000Z",
    _count: { memberships: 12, tasks: 30 },
    ...overrides,
  };
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl-1",
    name: "Restaurant",
    icon: "utensils",
    description: "Cafes, bars and restaurants",
    departments: [{ name: "Kitchen", description: "", color: "#EF4444" }],
    workRules: [],
    certifications: ["Food Safety"],
    isActive: true,
    isAiGenerated: false,
    usageCount: 3,
    createdAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("Platform dashboard", () => {
  it("shows the tier split from the server", async () => {
    stubFetch({ "/api/platform/stats": { body: STATS } });
    render(<Dashboard />);

    await screen.findByText("Subscription distribution");
    // Each label appears twice — once in the donut's legend and once in the
    // screen-reader table beside it. Both are deliberate.
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Enterprise").length).toBeGreaterThan(0);
  });

  it("makes one request, not one per resource", async () => {
    // It used to fetch the whole organisation list to count three numbers.
    const calls = stubFetch({ "/api/platform/stats": { body: STATS } });
    render(<Dashboard />);

    await screen.findByText("Subscription distribution");
    expect(calls).toHaveLength(1);
  });

  it("renders a tier it has no label for rather than dropping it", async () => {
    stubFetch({
      "/api/platform/stats": {
        body: { ...STATS, totalOrganizations: 5, tierCounts: { ...STATS.tierCounts, trial: 1 } },
      },
    });
    render(<Dashboard />);

    expect((await screen.findAllByText("trial")).length).toBeGreaterThan(0);
  });

  it("shows the server's own error message", async () => {
    stubFetch({
      "/api/platform/stats": {
        ok: false,
        status: 500,
        body: { error: "The column Organization.subscriptionTier does not exist" },
      },
    });
    render(<Dashboard />);

    expect(
      await screen.findByText(/column Organization.subscriptionTier does not exist/)
    ).toBeInTheDocument();
  });

  it("retries on demand after a failure", async () => {
    const user = userEvent.setup();
    const routes: Record<string, { ok?: boolean; status?: number; body: unknown }> = {
      "/api/platform/stats": { ok: false, status: 500, body: { error: "Boom" } },
    };
    stubFetch(routes);
    render(<Dashboard />);

    await screen.findByText("Boom");
    routes["/api/platform/stats"] = { body: STATS };
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Subscription distribution")).toBeInTheDocument();
  });

  it("says so instead of dividing by zero when there are no tenants", async () => {
    stubFetch({
      "/api/platform/stats": {
        body: {
          totalOrganizations: 0,
          activeOrganizations: 0,
          totalUsers: 0,
          totalTasks: 0,
          tierCounts: {},
        },
      },
    });
    render(<Dashboard />);

    expect(await screen.findByText(/No organisations yet/)).toBeInTheDocument();
    expect(screen.queryByText("NaN%")).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe("Organizations", () => {
  it("asks before suspending, and does not call the API until confirmed", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/organizations": { body: { organizations: [org()], total: 1 } },
    });
    render(<Organizations />);

    await user.click(await screen.findByRole("button", { name: "Suspend" }));

    expect(screen.getByText("Suspend Acme Diner?")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("names the number of people the suspension locks out", async () => {
    const user = userEvent.setup();
    stubFetch({
      "/api/platform/organizations": { body: { organizations: [org()], total: 1 } },
    });
    render(<Organizations />);

    await user.click(await screen.findByRole("button", { name: "Suspend" }));
    expect(screen.getByText(/All 12 members/)).toBeInTheDocument();
  });

  it("cancelling leaves the organisation alone", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/organizations": { body: { organizations: [org()], total: 1 } },
    });
    render(<Organizations />);

    await user.click(await screen.findByRole("button", { name: "Suspend" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Suspend Acme Diner?")).not.toBeInTheDocument()
    );
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("reinstating does not interrogate the user", async () => {
    // Asking twice for a harmless action trains people to click through the
    // prompt that matters.
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/organizations": {
        body: { organizations: [org({ status: "suspended" })], total: 1 },
      },
    });
    render(<Organizations />);

    await user.click(await screen.findByRole("button", { name: "Reinstate" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1)
    );
  });

  it("sends no body when toggling status, and a tier when changing tier", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/organizations": { body: { organizations: [org()], total: 1 } },
    });
    render(<Organizations />);

    await user.selectOptions(
      await screen.findByLabelText(/Subscription tier for Acme Diner/),
      "pro"
    );

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toEqual({ subscriptionTier: "pro" });
    });
  });

  it("does not call the API when the tier is re-selected unchanged", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/organizations": { body: { organizations: [org()], total: 1 } },
    });
    render(<Organizations />);

    await user.selectOptions(
      await screen.findByLabelText(/Subscription tier for Acme Diner/),
      "free"
    );

    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("filters by name", async () => {
    const user = userEvent.setup();
    stubFetch({
      "/api/platform/organizations": {
        body: {
          organizations: [org(), org({ id: "org-2", name: "Bistro Nine", slug: "bistro-nine" })],
          total: 2,
        },
      },
    });
    render(<Organizations />);

    await screen.findByText("Acme Diner");
    await user.type(screen.getByLabelText("Search organizations"), "bistro");

    expect(screen.queryByText("Acme Diner")).not.toBeInTheDocument();
    expect(screen.getByText("Bistro Nine")).toBeInTheDocument();
  });

  it("offers a way out when a filter matches nothing", async () => {
    const user = userEvent.setup();
    stubFetch({
      "/api/platform/organizations": { body: { organizations: [org()], total: 1 } },
    });
    render(<Organizations />);

    await screen.findByText("Acme Diner");
    await user.type(screen.getByLabelText("Search organizations"), "zzzz");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByText("Acme Diner")).toBeInTheDocument();
  });

  it("distinguishes an empty platform from a filtered-out list", async () => {
    stubFetch({
      "/api/platform/organizations": { body: { organizations: [], total: 0 } },
    });
    render(<Organizations />);

    expect(await screen.findByText("No organizations yet")).toBeInTheDocument();
  });

  it("shows the server's message when the list fails to load", async () => {
    stubFetch({
      "/api/platform/organizations": {
        ok: false,
        status: 500,
        body: { error: "Database connection lost" },
      },
    });
    render(<Organizations />);

    expect(await screen.findByText(/Database connection lost/)).toBeInTheDocument();
  });

  it("does not render a list when the payload is not an array", async () => {
    // The shape that crashed the deployed Tasks page: an error object where a
    // list was expected, then `.filter` on it.
    stubFetch({
      "/api/platform/organizations": { body: { error: "Forbidden" } },
    });
    render(<Organizations />);

    expect(await screen.findByText(/Forbidden/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe("Industry templates", () => {
  it("reports a failed load instead of showing an empty platform", async () => {
    // The bug this page had: `if (res.ok)` with no else, so a 500 rendered
    // "No templates yet" — identical to a healthy platform with none.
    stubFetch({
      "/api/platform/templates": {
        ok: false,
        status: 500,
        body: { error: "Internal server error" },
      },
    });
    render(<Templates />);

    expect(await screen.findByText("Internal server error")).toBeInTheDocument();
    expect(screen.queryByText("No templates yet")).not.toBeInTheDocument();
  });

  it("shows the empty state when the platform genuinely has none", async () => {
    stubFetch({ "/api/platform/templates": { body: [] } });
    render(<Templates />);

    expect(await screen.findByText("No templates yet")).toBeInTheDocument();
  });

  it("asks before deactivating, and says what survives", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({ "/api/platform/templates": { body: [template()] } });
    render(<Templates />);

    await user.click(await screen.findByRole("button", { name: "Deactivate" }));

    expect(screen.getByText("Deactivate Restaurant?")).toBeInTheDocument();
    expect(screen.getByText(/3 organisations already built from it keep everything/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("reactivating goes straight through", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/templates": { body: [template({ isActive: false })] },
    });
    render(<Templates />);

    await user.click(await screen.findByRole("button", { name: "Activate" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1)
    );
  });

  it("submits on Enter, because the form is a form", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/templates": { body: [] },
    });
    render(<Templates />);

    await user.click((await screen.findAllByRole("button", { name: "New Template" }))[0]);
    await user.type(screen.getByLabelText("Name"), "Logistics{Enter}");

    // No departments yet, so the submit is refused — but it was ATTEMPTED,
    // which is what proves Enter reaches the form.
    expect(
      await screen.findByText("Template description is required")
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses to save without a department", async () => {
    const user = userEvent.setup();
    stubFetch({ "/api/platform/templates": { body: [] } });
    render(<Templates />);

    await user.click((await screen.findAllByRole("button", { name: "New Template" }))[0]);
    await user.type(screen.getByLabelText("Name"), "Logistics");
    await user.type(screen.getByLabelText("Description"), "Delivery and warehousing");
    await user.click(screen.getByRole("button", { name: "Create template" }));

    expect(
      await screen.findByText("At least one department is required")
    ).toBeInTheDocument();
  });

  it("drops blank certification rows rather than sending them", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({ "/api/platform/templates": { body: [] } });
    render(<Templates />);

    await user.click((await screen.findAllByRole("button", { name: "New Template" }))[0]);
    await user.type(screen.getByLabelText("Name"), "Logistics");
    await user.type(screen.getByLabelText("Description"), "Delivery and warehousing");

    const depts = screen.getByText("Departments").closest("section")!;
    await user.click(within(depts).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("Name for department 1"), "Warehouse");

    const certs = screen.getByText("Certifications").closest("section")!;
    await user.click(within(certs).getByRole("button", { name: "Add" }));
    await user.click(within(certs).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("Certification 1"), "Forklift Licence");

    await user.click(screen.getByRole("button", { name: "Create template" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect((post?.body as { certifications: string[] })?.certifications).toEqual([
        "Forklift Licence",
      ]);
    });
  });

  it("does not claim a hand-written template when editing an AI one", async () => {
    // isAiGenerated was recomputed from the (always empty) prompt box on save.
    const user = userEvent.setup();
    const calls = stubFetch({
      "/api/platform/templates": { body: [template({ isAiGenerated: true })] },
    });
    render(<Templates />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      expect(patch!.body).not.toHaveProperty("isAiGenerated");
    });
  });

  it("editing loads a copy, so cancelling does not mutate the list", async () => {
    const user = userEvent.setup();
    stubFetch({ "/api/platform/templates": { body: [template()] } });
    render(<Templates />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Name for department 1"), " Prep");
    // Cancel appears twice on the edit view — in the header and at the foot.
    await user.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Name for department 1")).toHaveValue("Kitchen");
  });
});
