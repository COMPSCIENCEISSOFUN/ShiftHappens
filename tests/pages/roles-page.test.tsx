// @vitest-environment jsdom
/**
 * The Roles screen, rendered for the first time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import RolesPage from "@/app/(app)/org/[orgId]/roles/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

let granted = true;
/*
 * Which permissions the READER holds, when a test cares.
 *
 * Null means "everything", which is the company-admin case and what almost
 * every test on this page wants. A list is the delegate case: somebody given
 * `roles:manage` through a custom role, who can open this screen and must not
 * be offered permissions they do not hold themselves.
 */
let held: string[] | null = null;
/*
 * The plan, mocked alongside the permissions.
 *
 * This page is now behind two gates. Almost every test here is about what the
 * page SAYS once you are through them, so the default is a plan that includes
 * custom roles and a usage well under the cap — the tests that care about
 * either set it themselves.
 */
let planTier: "free" | "pro" | "enterprise" = "pro";
let customRoleUsage = 0;
vi.mock("@/components/layout/plan-provider", () => ({
  usePlan: () => ({
    tier: planTier,
    tierName: planTier === "free" ? "Free" : planTier === "pro" ? "Pro" : "Enterprise",
    // `priority_support` is the Enterprise-only example now; `audit_log`
    // moved to Pro on 2026-08-11. The mock has to keep ONE feature above Pro
    // or the page's plan-locked branch stops being exercised at all.
    has: (feature: string) =>
      planTier !== "free" &&
      (feature !== "priority_support" || planTier === "enterprise"),
    requiredTier: () => "pro",
    limitFor: () => (planTier === "enterprise" ? null : 10),
    usageOf: () => customRoleUsage,
    atLimit: () => planTier !== "enterprise" && customRoleUsage >= 10,
  }),
}));

vi.mock("@/components/layout/permission-provider", () => ({
  usePermissions: () => ({
    can: (permission: string) =>
      held === null ? granted : granted && held.includes(permission),
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
  held = null;
  planTier = "pro";
  customRoleUsage = 0;
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

/**
 * What a delegate is offered.
 *
 * `roles:manage` is delegable, and until now the picker showed the whole
 * catalogue to whoever held it — so a manager given the role builder could tick
 * `billing:manage`, save, and hold it on the next request. The refusal lives in
 * `RoleService.assertMayGrantPermissions`, because the endpoint takes whatever
 * list of ids it is sent and a disabled checkbox stops a mistake rather than a
 * request. This is the sign next to that fence.
 *
 * Nothing here fires for a company admin, who holds the whole catalogue.
 */
describe("permissions the author does not hold", () => {
  /** The checkbox for a permission, found by the text beside it. */
  function box(description: string) {
    return screen
      .getByText(description)
      .closest("label")!
      .querySelector("input") as HTMLInputElement;
  }

  it("disables the box and says why", async () => {
    held = ["roles:manage", "tasks:assign"];
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(box("View, create, update and delete work rules").disabled).toBe(true);
    expect(screen.getByText(/not yours to grant/i)).toBeInTheDocument();
  });

  it("leaves the ones they do hold alone", async () => {
    held = ["roles:manage", "tasks:assign"];
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(box("Assign staff to tasks").disabled).toBe(false);
  });

  it("offers an admin the whole catalogue", async () => {
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(box("View, create, update and delete work rules").disabled).toBe(false);
    expect(screen.queryByText(/not yours to grant/i)).not.toBeInTheDocument();
  });

  /*
   * The server checks only what is being ADDED — removing a permission grants
   * nobody anything — so a box that is already ticked has to stay clickable
   * even when the editor does not hold it. Disabling it would refuse an edit
   * the server would have accepted, and would trap an admin-built role in a
   * state whoever inherits it cannot reduce.
   */
  it("keeps an already-granted one editable so it can be removed", async () => {
    held = ["roles:manage", "tasks:assign"];
    mockApi([role({ rolePermissions: [{ permission: ASSIGN }, { permission: RULES }] })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));

    const rules = box("View, create, update and delete work rules");
    expect(rules.checked).toBe(true);
    expect(rules.disabled).toBe(false);
  });

  // Both reasons can apply at once. "Enterprise plan" is the one the reader can
  // act on, and two greyed badges on one line say less than either alone.
  it("prefers the plan badge when a permission is also out of plan", async () => {
    held = ["roles:manage"];
    mockApi([]);
    render(<RolesPage />);

    await screen.findAllByRole("button", { name: /new role/i });
    await userEvent.click(newRoleButton());

    expect(
      within(screen.getByText("View audit logs").closest("label")!).getByText(
        /Enterprise plan/i
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByText("View audit logs").closest("label")!).queryByText(
        /not yours to grant/i
      )
    ).not.toBeInTheDocument();
  });
});

/**
 * The delete confirmation.
 *
 * It said "Anyone currently holding this role loses the permissions it grants"
 * — true of every custom role ever created, and so no help in deciding whether
 * to press the button. Two facts change that decision and neither was on
 * screen: how many people hold it, and whether the reader is one of them.
 *
 * The second is the one this was written for. `customRoleId` is
 * `onDelete: SetNull`, so deleting a role you wear strips it from you as well —
 * and if `roles:manage` came to you through that role, you have just deleted
 * your own way back to this page.
 */
describe("what the delete confirmation says", () => {
  it("counts the people who lose the role", async () => {
    mockApi([role({ memberCount: 3 })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(screen.getByText(/3 members hold this role/)).toBeInTheDocument();
  });

  it("uses the singular for one", async () => {
    mockApi([role({ memberCount: 1 })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(screen.getByText(/1 member holds this role/)).toBeInTheDocument();
  });

  // Nobody wearing it is the safe case, and saying so is what makes the other
  // two readings mean something.
  it("says plainly when nobody holds it", async () => {
    mockApi([role({ memberCount: 0 })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(screen.getByText(/Nobody currently holds this role/)).toBeInTheDocument();
  });

  it("warns the reader when they hold it themselves", async () => {
    mockApi([role({ memberCount: 2, heldByCaller: true })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(screen.getByText(/You are one of them/)).toBeInTheDocument();
  });

  it("does not warn somebody who does not hold it", async () => {
    mockApi([role({ memberCount: 2, heldByCaller: false })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(screen.queryByText(/You are one of them/)).not.toBeInTheDocument();
  });

  // The card carries the same figure, so the number is visible before the
  // dialog rather than only at the moment of committing to it.
  it("shows the reach on the card as well", async () => {
    mockApi([role({ memberCount: 3, heldByCaller: true })]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    const text = card("Shift Lead").textContent ?? "";

    expect(text).toMatch(/3 members/);
    expect(text).toMatch(/including you/i);
  });
});

/**
 * The second gate.
 *
 * Custom roles are Pro and above, enforced by `enforceFeatureAccess` in the
 * service — and only there. A Free organisation saw the full builder: fourteen
 * categories of checkboxes, a working New Role button, a name and description
 * to fill in. The refusal arrived on save, after all of it.
 *
 * The cap is the same defect one step along. Pro allows ten roles and the
 * eleventh was refused the same way, having already been composed.
 */
describe("when the plan does not include custom roles", () => {
  it("says so instead of showing the builder", async () => {
    planTier = "free";
    mockApi([]);
    render(<RolesPage />);

    expect(await screen.findByText(/need the Pro plan/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new role/i })).toBeNull();
  });

  // The tier is named because "Pro" is actionable and "unavailable" is not, and
  // the reader is told where they stand so the sentence is a comparison.
  it("names the plan they are on as well as the one they need", async () => {
    planTier = "free";
    mockApi([]);
    render(<RolesPage />);

    expect(await screen.findByText(/on Free/)).toBeInTheDocument();
  });

  it("offers a way to act on it", async () => {
    planTier = "free";
    mockApi([]);
    render(<RolesPage />);

    expect(await screen.findByRole("link", { name: /view plans/i })).toHaveAttribute(
      "href",
      "/org/org1/settings"
    );
  });

  /*
   * The permission check comes FIRST, and this is what pins the order. Telling
   * somebody without `roles:manage` that they need a better plan names a
   * purchase that would not let them in either, while hiding the real reason.
   */
  it("tells a member without the permission about the permission, not the plan", async () => {
    planTier = "free";
    granted = false;
    mockApi([]);
    render(<RolesPage />);

    expect(
      await screen.findByText(/managed by company admins/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/need the Pro plan/i)).toBeNull();
  });
});

describe("when the organisation is at its role limit", () => {
  it("disables New Role rather than refusing on save", async () => {
    customRoleUsage = 10;
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(newRoleButton()).toBeDisabled();
  });

  it("shows how many of the allowance are used", async () => {
    customRoleUsage = 10;
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(screen.getByText(/10 of 10 roles/)).toBeInTheDocument();
    expect(screen.getByText(/limit reached/)).toBeInTheDocument();
  });

  // Shown from the first one used, not only when full — a cap you can see
  // approaching is a decision, one you meet is a refusal.
  it("shows the figure below the limit too", async () => {
    customRoleUsage = 3;
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(screen.getByText(/3 of 10 roles/)).toBeInTheDocument();
    expect(screen.queryByText(/limit reached/)).toBeNull();
  });

  it("leaves the button alone below the limit", async () => {
    customRoleUsage = 9;
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(newRoleButton()).toBeEnabled();
  });

  /*
   * Editing an existing role is not creating one, and neither is closing a form
   * that is already open — so being full must not lock the reader out of
   * changing what they already have.
   */
  it("still allows editing a role that exists", async () => {
    customRoleUsage = 10;
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(screen.getByRole("button", { name: /edit/i })).toBeEnabled();
  });

  it("says nothing about a limit on an unlimited plan", async () => {
    planTier = "enterprise";
    customRoleUsage = 40;
    mockApi([role()]);
    render(<RolesPage />);

    await screen.findByRole("heading", { name: "Shift Lead" });
    expect(screen.queryByText(/of 10 roles/)).toBeNull();
    expect(newRoleButton()).toBeEnabled();
  });
});
