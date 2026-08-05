// @vitest-environment jsdom
/**
 * The menu tallies with what the user may actually do.
 *
 * The sidebar decided what to show from `role === "company_admin" || role ===
 * "manager"`, so a custom role changed what the API would allow without
 * changing what the user was offered — and it failed in both directions:
 *
 *   - a "Shift Lead" granted `tasks:assign` never saw the Tasks link, so the
 *     permission was real and unreachable
 *   - a manager whose custom role withheld `reports:view` still saw the links
 *     and met a 403 on arrival
 *
 * Both are now decided by the same permissions the routes enforce.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ROLE_PERMISSIONS, PERMISSION_NAMES } from "@/lib/permissions";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));

// The bell polls on mount; nothing here depends on the count.
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) })
);

function renderNav(permissions: string[], role = "staff") {
  render(
    <AppSidebar
      user={{ name: "Alex Rivera", email: "alex@example.com" }}
      orgId="org-1"
      orgName="Ocean Grill"
      role={role}
      permissions={permissions}
    />
  );
}

/**
 * Every gated link, and EVERY permission that unlocks it.
 *
 * The full set matters. Several links accept alternatives — a role that may
 * assign shifts but not create them still needs the Tasks page — so a test that
 * withheld one permission and expected the link to vanish would pass only for
 * the single-permission entries and quietly prove nothing for the rest.
 */
const GATED_LINKS: { label: string; unlockedBy: string[] }[] = [
  {
    label: "Tasks",
    unlockedBy: ["tasks:create", "tasks:update", "tasks:delete", "tasks:assign"],
  },
  { label: "Calendar", unlockedBy: ["calendar:view_team"] },
  {
    /*
     * Five, not three. `members:update_seniority` and
     * `members:request_availability` reach this page too, and a DEFAULT
     * manager holds those two and none of the other three — so with the
     * shorter list the only screen exposing the seniority control was
     * unlinked for exactly the role the seniority route was written for.
     */
    label: "Members",
    unlockedBy: [
      "members:invite",
      "members:update_role",
      "members:deactivate",
      "members:update_seniority",
      "members:request_availability",
    ],
  },
  {
    label: "Departments",
    unlockedBy: ["departments:create", "departments:update", "departments:delete"],
  },
  { label: "Certifications", unlockedBy: ["certifications:review"] },
  { label: "Roles", unlockedBy: ["roles:manage"] },
  { label: "Work Rules", unlockedBy: ["work_rules:manage"] },
  { label: "Auto-Schedule", unlockedBy: ["allocation:auto_schedule"] },
  { label: "Audit Log", unlockedBy: ["audit:view"] },
  { label: "Settings", unlockedBy: ["settings:read"] },
];

describe("every gated link needs its permission", () => {
  it.each(GATED_LINKS)(
    "hides $label from someone holding every OTHER permission",
    ({ label, unlockedBy }) => {
      renderNav(PERMISSION_NAMES.filter((p) => !unlockedBy.includes(p)));
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  );

  it.each(GATED_LINKS.flatMap(({ label, unlockedBy }) =>
    unlockedBy.map((permission) => ({ label, permission }))
  ))("shows $label for $permission alone", ({ label, permission }) => {
    renderNav([permission]);
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  });

  // A typo in a permission name would hide its link forever and read as a
  // styling problem rather than a broken reference.
  it.each(GATED_LINKS.flatMap(({ unlockedBy }) => unlockedBy))(
    "%s is a permission that exists",
    (permission) => {
      expect(PERMISSION_NAMES).toContain(permission);
    }
  );
});

const PERSONAL_PAGES = ["My Tasks", "My Availability", "My Certifications"];

describe("personal pages belong to anyone who can be rostered", () => {
  /**
   * They carry no permission — being someone who can hold a shift is what
   * grants them.
   *
   * "My Tasks" was shown only to `role === "staff"`, so a MANAGER assigned to a
   * shift had nowhere in the product to accept it.
   */
  it.each(PERSONAL_PAGES)("shows %s to a staff member holding nothing", (label) => {
    renderNav([], "staff");
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  });

  it.each(PERSONAL_PAGES)("shows %s to a manager", (label) => {
    renderNav([], "manager");
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  });

  /**
   * And NOT to an admin. Three separate places refuse to roster one — the
   * eligibility engine, `assignStaff`, and `findSchedulableStaff` — so all
   * three pages are permanently empty for them, and availability and
   * certifications only feed a check they are never part of.
   *
   * The first version of the permission-driven sidebar made these
   * unconditional and offered admins all three.
   */
  it.each(PERSONAL_PAGES)("hides %s from a company admin", (label) => {
    renderNav([...PERMISSION_NAMES], "company_admin");
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  });

  /**
   * `Membership.role` is an unconstrained string, so a value outside the three
   * known roles is reachable. It must not be rosterable: the eligibility engine
   * and `findSchedulableStaff` both name the two roles explicitly, so a menu
   * that admitted anything-but-admin would offer pages the engine would never
   * fill.
   */
  it.each(PERSONAL_PAGES)("hides %s from an unrecognised role", (label) => {
    renderNav([], "supervisor");
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  });

  it.each(["Dashboard", "Profile"])("shows %s to everyone, including an admin", (label) => {
    renderNav([...PERMISSION_NAMES], "company_admin");
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  });
});

describe("the default bundles produce the menus they always did", () => {
  it("gives a plain manager the shift-running links", () => {
    renderNav([...ROLE_PERMISSIONS.manager], "manager");

    for (const label of ["Tasks", "Calendar", "Certifications"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Members too — a manager pins seniority and asks people to review their
    // availability, both of which live on that page and are in their bundle.
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument();

    // And none of the organisation-shaping ones.
    for (const label of ["Roles", "Work Rules", "Settings", "Audit Log"]) {
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
  });

  it("gives an admin everything", () => {
    renderNav([...PERMISSION_NAMES], "company_admin");

    for (const { label } of GATED_LINKS) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("gives a plain staff member only their own pages", () => {
    renderNav([...ROLE_PERMISSIONS.staff], "staff");

    for (const { label } of GATED_LINKS) {
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "My Tasks" })).toBeInTheDocument();
  });
});

describe("a custom role moves the menu with it", () => {
  /** The Shift Lead: a staff member who may fill shifts and nothing else. */
  it("gives a staff member the Tasks link when their role grants tasks:assign", () => {
    renderNav(["tasks:assign"], "staff");

    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument();
  });

  it("takes a link away from a manager whose role withholds it", () => {
    renderNav(
      [...ROLE_PERMISSIONS.manager].filter((p) => p !== "certifications:review"),
      "manager"
    );

    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Certifications" })
    ).not.toBeInTheDocument();
  });

  // Any one of the four shift powers is reason to be on the Tasks page — a role
  // that may assign but not create still needs it.
});
