/**
 * Which cards a reader gets.
 *
 * This replaces the question `dashboard-switch` used to ask. That file asserted
 * which of three components rendered; there are no longer three components, and
 * the reason is the case in the middle of this file — a permission granted to a
 * custom role that the old switch could not route to.
 */
import { describe, it, expect } from "vitest";

import {
  DASHBOARD_CARDS,
  bandGroups,
  cardsFor,
  cardsInBand,
  readerQualifies,
  type DashboardReader,
} from "@/lib/dashboard-cards";
import { PERMISSION_NAMES } from "@/lib/permissions";

/** A reader holding exactly what is listed and nothing else. */
function reader(
  permissions: string[],
  departmentScope: string[] | null,
  rosterable = true
): DashboardReader {
  return { permissions: new Set(permissions), departmentScope, rosterable };
}

const admin = reader(
  ["reports:view", "certifications:review", "billing:manage", "members:request_availability"],
  null,
  false
);
const manager = reader(
  ["reports:view", "calendar:view_team", "members:request_availability"],
  ["dept-1"]
);
const staff = reader([], ["dept-1"]);

const ids = (r: DashboardReader) => cardsFor(r).map((card) => card.id);

describe("the registry itself", () => {
  /*
   * A card naming a permission nobody can hold is a card nobody ever sees, and
   * it fails silently — which is the whole failure mode this file exists to
   * stop. `leave:review` was written here first and does not exist.
   */
  it("names only permissions that exist in the catalogue", () => {
    const named = DASHBOARD_CARDS.flatMap((card) =>
      card.permission === null
        ? []
        : typeof card.permission === "string"
          ? [card.permission]
          : [...card.permission]
    );

    expect([...new Set(named)].filter((p) => !PERMISSION_NAMES.includes(p))).toEqual([]);
  });

  it("gives every card a distinct id", () => {
    const seen = DASHBOARD_CARDS.map((card) => card.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /* Two cards at one priority would swap places between renders. */
  it("orders deterministically within a band", () => {
    expect(ids(admin)).toEqual(ids(admin));
  });
});

describe("who gets what", () => {
  it("gives a company admin the organisation-wide cards", () => {
    expect(ids(admin)).toEqual(
      expect.arrayContaining([
        "alerts",
        "key-metrics",
        "department-workload",
        "certification-summary",
        "billing-warning",
      ])
    );
  });

  /*
   * An admin holds no shifts, so the self-service cards would render empty by
   * construction rather than be withheld.
   */
  it("gives a company admin nothing personal", () => {
    expect(ids(admin)).not.toContain("next-shift");
    expect(ids(admin)).not.toContain("pending-offers");
    expect(ids(admin)).not.toContain("my-stats");
  });

  /*
   * The dashboards are NOT nested. `team-roster` is a scoped member's view of
   * their own team, and an admin has no own team — so the manager gets a card
   * the admin does not, which the three-component switch could not express.
   */
  it("gives a manager their team, and the admin not", () => {
    expect(ids(manager)).toContain("team-roster");
    expect(ids(admin)).not.toContain("team-roster");
  });

  it("withholds the two organisation-wide comparisons from a scoped manager", () => {
    expect(ids(manager)).not.toContain("department-workload");
    expect(ids(manager)).not.toContain("certification-summary");
  });

  it("gives a rostered manager their own shifts as well as their team's", () => {
    expect(ids(manager)).toContain("next-shift");
    expect(ids(manager)).toContain("team-roster");
  });

  it("gives plain staff only what is theirs", () => {
    expect(ids(staff)).toEqual(
      expect.arrayContaining(["pending-offers", "next-shift", "my-week", "my-stats"])
    );
    expect(ids(staff)).not.toContain("alerts");
    expect(ids(staff)).not.toContain("key-metrics");
  });
});

describe("the case the three-component switch could not express", () => {
  /*
   * A custom role adds `certifications:review` to somebody with no
   * `reports:view`. The old page routed on `reports:view` and sent them to the
   * personal dashboard, which had nowhere to put the section — while the API
   * gated it independently and would have returned it.
   */
  it("renders the card a custom role granted, without reports:view", () => {
    expect(ids(reader(["certifications:review"], null))).toContain(
      "certification-summary"
    );
  });

  it("still withholds everything that permission does not cover", () => {
    const reviewer = ids(reader(["certifications:review"], null));

    expect(reviewer).not.toContain("alerts");
    expect(reviewer).not.toContain("key-metrics");
  });

  it("adds exactly one card to a reader who gains one permission", () => {
    const before = ids(staff);
    const after = ids(reader(["calendar:view_team"], ["dept-1"]));

    expect(after.filter((id) => !before.includes(id))).toEqual(["team-roster"]);
  });
});

describe("scope is a requirement, not a rank", () => {
  /* A manager assigned to no departments is scoped to nothing, not everything. */
  it("gives a manager scoped to nothing no team card", () => {
    const unassigned = ids(reader(["reports:view", "calendar:view_team"], []));

    expect(unassigned).not.toContain("team-roster");
    expect(unassigned).toContain("alerts");
  });

  it("treats an empty scope as different from an unrestricted one", () => {
    expect(ids(reader(["reports:view"], []))).not.toContain("department-workload");
    expect(ids(reader(["reports:view"], null))).toContain("department-workload");
  });
});

describe("bands", () => {
  it("puts the things with a verb first", () => {
    const order = cardsFor(manager).map((card) => card.band);

    expect(order.lastIndexOf("needs")).toBeLessThan(order.indexOf("trend"));
  });

  it("returns an empty band rather than inventing a placeholder", () => {
    expect(cardsInBand(reader([], null, false), "needs")).toEqual([]);
  });
});

describe("readerQualifies", () => {
  it("refuses a rosterable card to somebody who holds no shifts", () => {
    const card = DASHBOARD_CARDS.find((c) => c.id === "next-shift")!;

    expect(readerQualifies(card, reader([], null, false))).toBe(false);
    expect(readerQualifies(card, reader([], null, true))).toBe(true);
  });
});

/*
 * The grouping exists because "Tomorrow — nothing scheduled, tomorrow is clear"
 * is the ORGANISATION's rota written in the second person, and a company admin
 * — who can never hold a shift — read it as a statement about their own day.
 * The bands organise by when something matters and say nothing about whose
 * numbers you are looking at, so every card was individually responsible for
 * saying so in its title. These pin the answer where the layout can reach it.
 */
describe("whose data a card is about", () => {
  it("marks nothing personal as being about the business", () => {
    const wrong = DASHBOARD_CARDS.filter(
      (card) => card.rosterable && card.subject !== "self"
    ).map((card) => card.id);

    // A card is `rosterable` because it shows the reader THEIR OWN shifts,
    // hours or certificates. There is no such thing as one of those that is
    // about the company.
    expect(wrong).toEqual([]);
  });

  it("gives a company admin nothing but business cards", () => {
    const subjects = cardsFor(admin).map((card) => card.subject);

    expect(subjects.length).toBeGreaterThan(0);
    expect([...new Set(subjects)]).toEqual(["org"]);
  });

  it("gives a manager both kinds, which is the reader the heading is for", () => {
    const subjects = new Set(cardsFor(manager).map((card) => card.subject));

    expect([...subjects].sort()).toEqual(["org", "self"]);
  });

  it("puts your own things above the business within a band", () => {
    const groups = bandGroups(manager, "now");

    expect(groups.map((group) => group.subject)).toEqual(["self", "org"]);
  });

  it("omits a group rather than returning it empty", () => {
    // A plain staff member has no business cards at all, so the layout must be
    // told there is no group rather than asked to hide an empty heading.
    expect(bandGroups(staff, "now").map((group) => group.subject)).toEqual([
      "self",
    ]);
  });

  /*
   * The canary. Every assertion above passes trivially if `bandGroups` returns
   * nothing at all, and two of them are about what is ABSENT.
   */
  it("returns every card of the band across its groups", () => {
    for (const band of ["now", "trend"] as const) {
      const grouped = bandGroups(manager, band).flatMap((group) => group.cards);

      expect(grouped.map((card) => card.id).sort()).toEqual(
        cardsInBand(manager, band)
          .map((card) => card.id)
          .sort()
      );
    }
  });
});

/**
 * Who the Today / Trends split is actually for.
 *
 * The dashboard shows the two tabs only when the trend band holds something
 * about the ORGANISATION. A count alone was not enough: `my-stats` carries no
 * permission and `rosterable: true`, so every staff member qualifies for it —
 * which made a naive "both halves are non-empty" check pass for them and
 * produced a Trends tab holding exactly one card, about themselves.
 *
 * These assert the registry facts that decision rests on, so a card whose
 * subject or permission changes fails here rather than quietly restoring a tab
 * to people it was never meant for.
 */
describe("whether a reader has organisational trends", () => {
  const orgTrends = (r: DashboardReader) =>
    cardsInBand(r, "trend").filter((card) => card.subject === "org");

  it("gives staff no org-level trend card", async () => {
    expect(orgTrends(staff)).toHaveLength(0);
  });

  it("still gives staff their own stats", async () => {
    // The tab goes away; the card must not. It is rendered inline instead.
    const own = cardsInBand(staff, "trend").filter((c) => c.subject === "self");
    expect(own.map((c) => c.id)).toContain("my-stats");
  });

  it("gives a manager org-level trends, which is what the tab is for", async () => {
    expect(orgTrends(manager).length).toBeGreaterThan(0);
  });

  it("gives an admin org-level trends too", async () => {
    expect(orgTrends(admin).length).toBeGreaterThan(0);
  });

  it("keeps every org trend card behind a permission", async () => {
    /*
     * The property that makes the check above meaningful. If an org-subject
     * trend card were ever added with `permission: null`, every staff member
     * would qualify for it and the tabs would silently come back.
     */
    const unguarded = DASHBOARD_CARDS.filter(
      (card) =>
        card.band === "trend" && card.subject === "org" && card.permission === null
    );
    expect(unguarded).toEqual([]);
  });
});
