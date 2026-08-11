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
import { PlanProvider } from "@/components/layout/plan-provider";
import { ROLE_PERMISSIONS, PERMISSION_NAMES } from "@/lib/permissions";
import type { SubscriptionTier } from "@/lib/subscription-tiers";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));

// The bell polls on mount; nothing here depends on the count.
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) })
);

/*
 * Enterprise by default, because this file is about PERMISSIONS.
 *
 * Two links — Roles and Audit Log — are gated by plan as well, and on any lower
 * tier they would be absent for a reason this file is not testing. The plan
 * gate has its own tests below; keeping the default at the top tier means a
 * failure here means what it says.
 */
function renderNav(
  permissions: string[],
  role = "staff",
  tier: SubscriptionTier = "enterprise"
) {
  render(
    <PlanProvider tier={tier}>
      <AppSidebar
        user={{ name: "Alex Rivera", email: "alex@example.com" }}
        orgId="org-1"
        orgName="Ocean Grill"
        role={role}
        permissions={permissions}
      />
    </PlanProvider>
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

const PERSONAL_PAGES = [
  "My Tasks",
  "My History",
  "My Availability",
  "My Certifications",
];

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

/**
 * The second gate: the plan.
 *
 * Two destinations are tier-gated as well as permission-gated, and both can
 * only deny. A company admin holds every permission in the catalogue regardless
 * of what the organisation pays, so without this the menu offered a Free
 * organisation the role builder and a Pro one the audit log — both of which
 * refuse on arrival.
 *
 * This used to be fetched on mount and defaulted to "allowed" until the answer
 * came back, so both links appeared on every page load and then disappeared. A
 * link that is briefly clickable and never valid is worse than one that was
 * never shown; the tier now arrives with the rest of the chrome.
 */
describe("the plan hides what it does not include", () => {
  it("hides Roles on a Free organisation, permission or not", () => {
    renderNav(["roles:manage"], "company_admin", "free");
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
  });

  it("shows Roles once the plan includes custom roles", () => {
    renderNav(["roles:manage"], "company_admin", "pro");
    expect(screen.getByRole("link", { name: "Roles" })).toBeInTheDocument();
  });

  /*
   * FREE is the case worth pinning now: it is the tier where the permission
   * says yes and the plan says no. `audit_log` moved to Pro on 2026-08-11, so
   * the Pro assertion below is inverted rather than deleted — the entry it
   * proves is hidden-then-shown is the same one, at a different boundary.
   */
  it("hides the Audit Log on Free", () => {
    renderNav(["audit:view"], "company_admin", "free");
    expect(screen.queryByRole("link", { name: "Audit Log" })).not.toBeInTheDocument();
  });

  it("shows the Audit Log on Pro", () => {
    renderNav(["audit:view"], "company_admin", "pro");
    expect(screen.getByRole("link", { name: "Audit Log" })).toBeInTheDocument();
  });

  it("shows the Audit Log on Enterprise", () => {
    renderNav(["audit:view"], "company_admin", "enterprise");
    expect(screen.getByRole("link", { name: "Audit Log" })).toBeInTheDocument();
  });

  /*
   * The positive control. A plan check that hid everything would satisfy the
   * two negative assertions above, and neither of these links is tier-gated.
   */
  it("leaves the ungated links alone on the lowest plan", () => {
    renderNav(["tasks:assign", "settings:read"], "manager", "free");
    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  // The plan alone is not enough either — both gates have to agree.
  it("still needs the permission on a plan that includes the feature", () => {
    renderNav(["tasks:assign"], "manager", "enterprise");
    expect(screen.queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit Log" })).not.toBeInTheDocument();
  });

  it("names the plan in the header", () => {
    renderNav(["tasks:assign"], "manager", "pro");
    expect(screen.getByText("Pro")).toBeInTheDocument();
  });
});

/**
 * Everybody who can hold a shift gets My Schedule.
 *
 * ## What this used to assert, and why it changed
 *
 * Two entries drew the same week. Calendar is gated on `calendar:view_team`;
 * My Schedule on `canBeRostered`. A manager trips both — they work shifts AND
 * run the roster — so they alone saw the duplication, and My Schedule was
 * withheld from anyone who could open Calendar.
 *
 * That argument was explicitly about MENU CLUTTER, and it held only while the
 * two pages drew the same week from the same data. They no longer do: My
 * Schedule carries the calendar subscribe link (US-81) and Calendar does not,
 * so the subtraction left a rostered manager unable to reach the one place
 * that offers to put their shifts in their phone — while the staff they manage
 * could.
 *
 * A duplicate view is a smaller cost than a feature half the rosterable
 * population cannot find. Inverted rather than deleted, so the original
 * reasoning stays readable next to the reason it stopped applying.
 */
describe("everybody rosterable gets My Schedule", () => {
  it("gives a staff member My Schedule", () => {
    renderNav(["tasks:assign"], "staff");

    expect(screen.getByRole("link", { name: "My Schedule" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Calendar" })).not.toBeInTheDocument();
  });

  // The case the change is for: a manager works shifts too, so the subscribe
  // link has to be reachable for them.
  it("gives a manager both", () => {
    renderNav([...ROLE_PERMISSIONS.manager], "manager");

    expect(screen.getByRole("link", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Schedule" })).toBeInTheDocument();
  });

  /*
   * The permission, not the role. A staff member granted `calendar:view_team`
   * through a custom role is in the same position as a manager — and while the
   * subtraction stood, a rule written against `role === "manager"` would have
   * handed them both anyway. The assertion is inverted now; the point it was
   * making is that this branch reads the PERMISSION, which is still true and
   * still worth pinning.
   */
  it("follows the permission rather than the job title", () => {
    renderNav(["calendar:view_team"], "staff");

    expect(screen.getByRole("link", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Schedule" })).toBeInTheDocument();
  });

  /*
   * An admin is not rostered, so the personal page is not theirs — and this is
   * the assertion that did NOT change. A feed of an admin's shifts would be
   * empty by construction, and `canBeRostered` being forgotten is a mistake
   * this codebase has made three times.
   */
  it("gives an admin the team calendar alone", () => {
    renderNav([...PERMISSION_NAMES], "company_admin");

    expect(screen.getByRole("link", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My Schedule" })).not.toBeInTheDocument();
  });

  // The rest of the personal group is untouched: only the CALENDAR was doubled.
  it("leaves a manager's other personal pages alone", () => {
    renderNav([...ROLE_PERMISSIONS.manager], "manager");

    expect(screen.getByRole("link", { name: "My Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My History" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Availability" })).toBeInTheDocument();
  });
});
