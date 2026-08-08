// @vitest-environment jsdom
/**
 * The Roles screen, rendered for the first time.
 *
 * It has been through three behaviour fixes and a visual overhaul without ever
 * being in a test — the sort of file where "green" and "seen" have never been
 * the same claim.
 *
 * What is asserted is what the page SAYS a role does, because that is where it
 * has been wrong twice. It described a role by listing its grants, which was a
 * complete description only while roles could not remove anything; in between,
 * handing a role to a manager silently took twelve permissions away and nothing
 * on this card mentioned it. The wording is therefore load-bearing rather than
 * decorative, and it belongs in a test for the same reason the empty-role
 * warning does: both have now been true in more than one way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import RolesPage from "@/app/(app)/org/[orgId]/roles/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

let granted = true;
vi.mock("@/components/layout/permission-provider", () => ({
  usePermissions: () => ({
    can: () => granted,
    canAny: () => granted,
    loading: false,
  }),
}));

const ASSIGN = {
  id: "p1",
  name: "tasks:assign",
  description: "Assign staff to tasks",
  category: "tasks",
};
const AUDIT = {
  id: "p2",
  name: "audit:view",
  description: "View audit logs",
  category: "audit",
  available: false,
  requiredTier: "Enterprise",
};
// A category whose raw name is not a word. The picker printed these verbatim.
const RULES = {
  id: "p3",
  name: "work_rules:manage",
  description: "View, create, update and delete work rules",
  category: "work_rules",
};

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "shift_lead",
    displayLabel: "Shift Lead",
    description: "Runs the floor",
    isSystemRole: false,
    rolePermissions: [{ permission: ASSIGN }],
    ...overrides,
  };
}

function mockApi(roles: unknown[], permissions: unknown[] = [ASSIGN, AUDIT, RULES]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = String(url).includes("/permissions") ? permissions : roles;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as Response);
    })
  );
}

/**
 * The card for a role, found by its heading rather than by position.
 *
 * `closest("div")` from the heading lands on the title wrapper, whose text is
 * only the label and description — an assertion scoped to that passes or fails
 * for reasons unrelated to the permission block below it. Climbing to the
 * outer card by its own class is the smallest thing that actually contains
 * both halves.
 */
function card(label: string) {
  return screen
    .getByRole("heading", { name: label })
    .closest("div.overflow-hidden") as HTMLElement;
}

/**
 * The header's New Role button.
 *
 * With no roles at all the empty state renders a second one, so an unscoped
 * query finds two and throws — and it throws only in the fixtures that pass an
 * empty list, which is the sort of thing that looks like a page bug from the
 * failure message alone.
 */
function newRoleButton() {
  return screen.getAllByRole("button", { name: /new role/i })[0];
}

beforeEach(() => {
  granted = true;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the page says a role does", () => {
  /*
   * The sentence that did not exist while it was most needed. An admin reading
   * this card could not tell how the role combined with the holder's system
   * role — and for as long as roles replaced that bundle, the natural reading
   * was the wrong one.
   */
  it("says the permissions are added to the system role", async () => {
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(
      within(card("Shift Lead")).getByText(/Added to whatever the member/)
    ).toBeInTheDocument();
  });

  it("names both audiences, since the answer differs for each", async () => {
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    const text = card("Shift Lead").textContent ?? "";

    // A staff member holds nothing by default, so the list is all they can do;
    // a manager keeps their bundle underneath. Asserting only one of the two
    // would pass on a sentence that told half the story, which is the failure
    // this whole screen has a history of.
    expect(text).toMatch(/staff member/i);
    expect(text).toMatch(/manager keeps/i);
  });

  /*
   * Third wording of this warning, and the first two were each true when
   * written — "sign in and see nothing else" before permissions were enforced,
   * then "grants nothing" while roles replaced the bundle. It is now inert, and
   * the test names the wording so a fourth change has to come through here.
   */
  it("warns that an empty role has no effect", async () => {
    mockApi([role({ rolePermissions: [] })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    const text = card("Shift Lead").textContent ?? "";

    expect(text).toMatch(/no effect/i);
    expect(text).not.toMatch(/not even the task list/i);
  });
});

describe("the permission chips", () => {
  /*
   * `tasks:assign` is an identifier for the catalogue; this screen is read by
   * whoever runs the venue. The picker directly above has always shown
   * descriptions, so one page named the same thing two ways.
   */
  it("show the description rather than the slug", async () => {
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    const chips = within(card("Shift Lead"));

    expect(chips.getByText("Assign staff to tasks")).toBeInTheDocument();
    expect(chips.queryByText("tasks:assign")).not.toBeInTheDocument();
  });

  // The slug stays reachable for anyone debugging a role, just not in the way.
  it("keep the slug on the tooltip", async () => {
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(screen.getByText("Assign staff to tasks")).toHaveAttribute(
      "title",
      "tasks:assign"
    );
  });
});

describe("the permission picker", () => {
  /*
   * The route guard checks the plan BEFORE the permission, so ticking a
   * plan-gated box opens nothing. Custom roles are Pro and above while the
   * audit log is Enterprise-only, making this a guaranteed no-op for every
   * organisation able to see the screen at all — enforcement was always
   * correct, the builder just did not say so.
   */
  it("disables a permission the plan does not include, and names the tier", async () => {
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(screen.getByText("View audit logs").closest("label")).toBeTruthy();
    const box = screen
      .getByText("View audit logs")
      .closest("label")!
      .querySelector("input") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Enterprise plan/i)).toBeInTheDocument();
  });

  /*
   * An empty catalogue has two very different causes and the page used to blame
   * the wrong one for both. `Permission` rows come from `prisma db seed`, which
   * nothing runs automatically, so telling an admin to reload sends them round
   * a loop that cannot end.
   */
  it("says to seed the catalogue when it comes back empty", async () => {
    mockApi([], []);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(screen.getByText(/has not been seeded/)).toBeInTheDocument();
    expect(screen.queryByText(/Reload the page/)).not.toBeInTheDocument();
  });

  /*
   * Both forms read one `selectedPermissions` array. With the create form open,
   * clicking Edit used to render both — ticking a box in one moved it in the
   * other, and whichever you saved won. Opening either must close the other,
   * which is the only way one shared selection can be correct.
   */
  it("closes the create form when editing starts", async () => {
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());
    expect(screen.getByText("New custom role")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.queryByText("New custom role")).not.toBeInTheDocument();
    expect(screen.getByText("Editing Shift Lead")).toBeInTheDocument();
  });
});

describe("the category headings", () => {
  /*
   * `work_rules` and `organization` were printed straight from the catalogue
   * row — a database value used as a label, which is the same defect as the
   * permission chips printing `tasks:assign`.
   */
  it("give a category a readable name rather than its raw key", async () => {
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(screen.getByText("Work rules")).toBeInTheDocument();
    expect(screen.queryByText("work_rules")).not.toBeInTheDocument();
  });

  /*
   * A count per category, because composing a role is a question per area —
   * "have I given them everything they need for tasks?" — and the single total
   * above the picker cannot answer it with fourteen categories on screen.
   *
   * Asserted by ticking a box and watching a number appear, rather than by
   * looking for a rendered "1": a static assertion would pass on a badge that
   * always showed the same figure.
   */
  it("count what is ticked in each category", async () => {
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    const heading = screen.getByText("Work rules").closest("div")!
      .parentElement as HTMLElement;
    expect(within(heading).queryByText("1")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText(RULES.description));

    expect(within(heading).getByText("1")).toBeInTheDocument();
  });
});

describe("the summary tiles", () => {
  /*
   * The "System" tile counted `isSystemRole` rows. Nothing in the application
   * creates one — no seed, no service, no migration — so it read 0 on every
   * organisation that has ever existed, and a quarter of the summary was a
   * constant. The lock badge and the read-only branch went with it.
   */
  it("do not offer a count of system roles", async () => {
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });

    expect(screen.queryByText("System")).not.toBeInTheDocument();
    expect(screen.getByText("Custom roles")).toBeInTheDocument();
  });

  /*
   * The filter that survived the UI removal, and it needs its own fixture: no
   * other test in this file has an `isSystemRole` row, so dropping the filter
   * altogether passed everything — a real gap rather than an equivalent
   * mutant, since the claim being made is about a row shape none of the other
   * fixtures produce.
   *
   * Such a row cannot exist today. But three services still guard against
   * editing, deleting and assigning one, seeding them is a deferred option
   * rather than a rejected one, and if it ever happens this page must not offer
   * an Edit button on a role it cannot change.
   */
  it("keep a system role out of the editable list if one ever exists", async () => {
    mockApi([
      role(),
      role({
        id: "r2",
        name: "manager",
        displayLabel: "Manager",
        isSystemRole: true,
      }),
    ]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });

    expect(screen.queryByRole("heading", { name: "Manager" })).toBeNull();
    // One role listed, so one Edit button — not two.
    expect(screen.getAllByRole("button", { name: /edit/i })).toHaveLength(1);
  });
});

describe("who may be here", () => {
  /*
   * The sidebar hid this page from non-admins, but the URL worked: a manager
   * who typed it got the full shell and a populated role list, because the
   * roles GET required only membership.
   */
  it("refuses a member without roles:manage", async () => {
    granted = false;
    mockApi([role()]);
    render(<RolesPage />);

    expect(
      await screen.findByText(/Roles are managed by company admins/)
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Shift Lead" })).toBeNull();
  });
});
