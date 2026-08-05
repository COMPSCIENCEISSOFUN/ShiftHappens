// @vitest-environment jsdom
/**
 * Departments — search and filter.
 *
 * The interesting cases are the ones where a filter can quietly lie: an
 * archived department appearing under a staffing pill, a count that moves as
 * you type, or a search that returns nothing when the thing you searched for
 * exists one filter away.
 *
 * The page is rendered rather than the predicates unit-tested, because the
 * predicates are private and the bug that matters is what ends up on screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DepartmentsPage from "@/app/(app)/org/[orgId]/departments/page";
import { PermissionProvider } from "@/components/layout/permission-provider";

vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-1" }) }));

function dept(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    name: "Kitchen",
    description: "Back of house",
    color: "#EF4444",
    archivedAt: null,
    _count: { departmentMemberships: 4, tasks: 6 },
    ...overrides,
  };
}

const DEPARTMENTS = [
  dept({ id: "d1", name: "Kitchen", _count: { departmentMemberships: 4, tasks: 6 } }),
  dept({
    id: "d2",
    name: "Front of house",
    description: "Service floor",
    _count: { departmentMemberships: 0, tasks: 3 },
  }),
  dept({
    id: "d3",
    name: "Deliveries",
    description: "Drivers and dispatch",
    _count: { departmentMemberships: 2, tasks: 0 },
  }),
  dept({
    id: "d4",
    name: "Old Bar",
    description: "Closed 2025",
    archivedAt: "2026-01-01T00:00:00.000Z",
    _count: { departmentMemberships: 0, tasks: 0 },
  }),
];

function stubFetch(body: unknown = DEPARTMENTS, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  stubFetch();
});

/** The pill button, so a count assertion can be scoped to it. */
function pill(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

/**
 * Rendered inside a provider granting the department permissions.
 *
 * The page now hides Create, Edit, Archive, Restore and Delete behind the
 * permission each one's endpoint enforces, and the provider denies by default —
 * so a page rendered without one shows no actions at all. That default is
 * deliberate (a wiring mistake should hide buttons, not reveal them), which
 * makes stating the permissions part of the fixture.
 */
function renderPage(
  permissions = ["departments:create", "departments:update", "departments:delete"]
) {
  render(
    <PermissionProvider permissions={permissions}>
      <DepartmentsPage />
    </PermissionProvider>
  );
}

async function loaded(permissions?: string[]) {
  renderPage(permissions);
  await screen.findByText("Kitchen");
}

/* ------------------------------------------------------------------ */

describe("pill counts", () => {
  it("counts each filter over the whole set", async () => {
    await loaded();

    expect(within(pill("All")).getByText("3")).toBeInTheDocument();
    expect(within(pill("Staffed")).getByText("2")).toBeInTheDocument();
    expect(within(pill("Empty")).getByText("1")).toBeInTheDocument();
    expect(within(pill("With tasks")).getByText("2")).toBeInTheDocument();
    expect(within(pill("No tasks")).getByText("1")).toBeInTheDocument();
    expect(within(pill("Archived")).getByText("1")).toBeInTheDocument();
  });

  it("excludes archived departments from every active pill", async () => {
    // "Old Bar" has no members and no tasks. If archived rows leaked into the
    // staffing filters it would inflate both Empty and No tasks to 2, and the
    // grid would put a card with a Delete Permanently button among editable
    // ones.
    await loaded();

    expect(within(pill("Empty")).getByText("1")).toBeInTheDocument();
    expect(within(pill("No tasks")).getByText("1")).toBeInTheDocument();
    expect(within(pill("All")).getByText("3")).toBeInTheDocument();
  });

  it("does not move the counts as you type", async () => {
    // The pills answer "how many departments have nobody?" — a property of the
    // organisation, not of the search box. Counts that collapsed to 0 on a
    // non-matching search would make the pills useless as a starting point.
    const user = userEvent.setup();
    await loaded();

    await user.type(screen.getByLabelText(/Search departments/), "zzzz");
    await waitFor(() =>
      expect(screen.getByText(/No departments match/)).toBeInTheDocument()
    );

    expect(within(pill("All")).getByText("3")).toBeInTheDocument();
    expect(within(pill("Staffed")).getByText("2")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe("filtering", () => {
  it("shows everything active by default, and nothing archived", async () => {
    await loaded();

    expect(screen.getByText("Front of house")).toBeInTheDocument();
    expect(screen.getByText("Deliveries")).toBeInTheDocument();
    expect(screen.queryByText("Old Bar")).not.toBeInTheDocument();
  });

  it("Empty shows only departments with nobody assigned", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.click(pill("Empty"));

    expect(screen.getByText("Front of house")).toBeInTheDocument();
    expect(screen.queryByText("Kitchen")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliveries")).not.toBeInTheDocument();
  });

  it("No tasks is a different question from Empty", async () => {
    // Deliveries has people but no work; Front of house has work but no people.
    // A filter that conflated the two would be worse than not having it.
    const user = userEvent.setup();
    await loaded();

    await user.click(pill("No tasks"));

    expect(screen.getByText("Deliveries")).toBeInTheDocument();
    expect(screen.queryByText("Front of house")).not.toBeInTheDocument();
  });

  it("Archived shows the archived card, with its own actions", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.click(pill("Archived"));

    expect(screen.getByText("Old Bar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Permanently" })
    ).toBeInTheDocument();
  });

  it("never renders a Delete Permanently button among active departments", async () => {
    // The reason archived cards are a separate component. A single card whose
    // buttons change meaning based on a flag is how somebody eventually clicks
    // the wrong one.
    await loaded();

    expect(
      screen.queryByRole("button", { name: "Delete Permanently" })
    ).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */

describe("search", () => {
  it("matches on name", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.type(screen.getByLabelText(/Search departments/), "deliv");

    await waitFor(() => expect(screen.queryByText("Kitchen")).not.toBeInTheDocument());
    expect(screen.getByText("Deliveries")).toBeInTheDocument();
  });

  it("matches on description too", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.type(screen.getByLabelText(/Search departments/), "service floor");

    // Wait on the card that should VANISH. Waiting on one already rendered
    // resolves before the 250ms debounce fires, and the test then asserts
    // against an unfiltered grid.
    await waitFor(() =>
      expect(screen.queryByText("Kitchen")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Front of house")).toBeInTheDocument();
  });

  it("is case insensitive", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.type(screen.getByLabelText(/Search departments/), "KITCHEN");

    await waitFor(() =>
      expect(screen.queryByText("Deliveries")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
  });

  it("composes with the active pill rather than replacing it", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.click(pill("Staffed"));
    await user.type(screen.getByLabelText(/Search departments/), "kitchen");

    await waitFor(() =>
      expect(screen.queryByText("Deliveries")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
  });

  it("says when the match lives under a different filter", async () => {
    // Searching for something archived while looking at All returns nothing.
    // Without this line the feature reads as broken rather than as filtered.
    const user = userEvent.setup();
    await loaded();

    await user.type(screen.getByLabelText(/Search departments/), "old bar");

    expect(
      await screen.findByText(/1 department elsewhere matches that search/)
    ).toBeInTheDocument();
  });

  it("offers a way back when nothing matches", async () => {
    const user = userEvent.setup();
    await loaded();

    await user.click(pill("Empty"));
    await user.type(screen.getByLabelText(/Search departments/), "kitchen");

    await user.click(await screen.findByRole("button", { name: "Clear filters" }));

    // Clearing resets the input immediately but `search` trails it by the
    // debounce, so the grid refills a moment later.
    expect(await screen.findByText("Deliveries")).toBeInTheDocument();
    expect(screen.getByText("Kitchen")).toBeInTheDocument();
  });

  it("distinguishes an org with no departments from a filtered-out list", async () => {
    stubFetch([]);
    renderPage();

    expect(await screen.findByText("No departments yet")).toBeInTheDocument();
    expect(screen.queryByText(/Clear filters/)).not.toBeInTheDocument();
  });
});

/**
 * The page had NO role check of any kind. A manager arriving by URL was offered
 * "+ New Department", plus Edit, Archive and Delete on every row — four actions
 * that each returned 403 — alongside stat tiles counting every department and
 * member in the organisation, which is outside the scope they are held to
 * everywhere else in the product.
 *
 * Hiding a button is not a security boundary; the routes refuse these
 * independently. It is so the product stops offering what it will not do.
 */
describe("actions follow the caller's permissions", () => {
  /*
   * The page is no longer reachable at all without one of the reader
   * permissions. It was: the buttons were hidden but the LIST rendered, with
   * org-wide member and task counts, for anyone who typed the URL — and the
   * GET route agreed, requiring only membership. Both halves are now gated on
   * `DEPARTMENT_LIST_READERS`.
   */
  it("refuses the page to someone holding no permissions at all", async () => {
    renderPage([]);

    expect(
      await screen.findByText(/don't have access to Departments/i)
    ).toBeInTheDocument();
    expect(screen.queryByText("Kitchen")).not.toBeInTheDocument();
  });

  /*
   * A reader is not an editor. `tasks:create` is on the reader list because the
   * task form picks a department — so that holder must SEE the list and be
   * offered none of the actions. This is the case the old test was reaching
   * for; it just used the empty set, which no longer gets through the door.
   */
  it("shows the list but no actions to a reader who cannot edit", async () => {
    await loaded(["tasks:create"]);

    expect(screen.getByText("Kitchen")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ New Department" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("offers create only with departments:create", async () => {
    await loaded(["departments:create"]);

    expect(
      screen.getByRole("button", { name: "+ New Department" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("offers edit and archive only with departments:update", async () => {
    await loaded(["departments:update"]);

    // getAllBy, not getBy: the fixture has several active departments and each
    // one carries its own pair of buttons.
    expect(screen.getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Archive" }).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "+ New Department" })
    ).not.toBeInTheDocument();
  });

  /**
   * Delete is its own permission again. The shared guard checked
   * `departments:update` for GET, PATCH *and* DELETE, so `departments:delete`
   * could be ticked and was never consulted while update silently carried the
   * power to destroy a department.
   */
  it("separates permanent delete from restore on an archived department", async () => {
    const user = userEvent.setup();
    await loaded(["departments:update"]);
    await user.click(pill("Archived"));

    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Permanently" })
    ).not.toBeInTheDocument();
  });

  it("offers permanent delete with departments:delete", async () => {
    const user = userEvent.setup();
    await loaded(["departments:delete"]);
    await user.click(pill("Archived"));

    expect(
      screen.getByRole("button", { name: "Delete Permanently" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});
