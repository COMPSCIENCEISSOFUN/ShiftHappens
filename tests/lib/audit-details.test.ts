/**
 * What an audit row says it did.
 */
import { describe, it, expect } from "vitest";
import { ACTIONS, type AuditAction } from "@/lib/audit-actions";
import { summariseAudit } from "@/lib/audit-details";

const ALL_ACTIONS = Object.values(ACTIONS) as AuditAction[];

describe("every action has an answer", () => {
  /*
   * The canary. `summariseAudit` returns null for an action it does not know,
   * and null is also a legitimate answer — so a registry that had lost every
   * entry would look identical to one where nothing happened to have details.
   * This distinguishes them: a KNOWN action given data must speak.
   */
  it("summarises a known action rather than falling through", () => {
    expect(summariseAudit(ACTIONS.DEPARTMENT_ARCHIVED, { name: "Kitchen" })).toBe(
      "Kitchen"
    );
  });

  it("never throws, whatever the row holds", () => {
    const junk = [
      null,
      undefined,
      {},
      { name: 42 },
      { days: "not an array" },
      { membershipIds: null },
      { from: {}, to: [] },
    ];

    for (const action of ALL_ACTIONS) {
      for (const details of junk) {
        expect(() => summariseAudit(action, details)).not.toThrow();
      }
    }
  });

  /*
   * `details` is a Json column written by twenty-three services across several
   * months. Rows predating a field simply lack it, and those are the oldest
   * rows in the table — the ones an audit log exists to keep.
   */
  it("returns null rather than an empty or ragged string", () => {
    for (const action of ALL_ACTIONS) {
      const answer = summariseAudit(action, {});
      expect(answer === null || answer.trim().length > 0).toBe(true);
    }
  });
});

describe("what a row says", () => {
  it("names the department, not its id", () => {
    expect(
      summariseAudit(ACTIONS.DEPARTMENT_DELETED, {
        name: "Front of House",
        id: "cmf3k2xyz",
      })
    ).toBe("Front of House");
  });

  it("shows a plan change as a movement", () => {
    expect(
      summariseAudit(ACTIONS.ORGANIZATION_TIER_CHANGED, {
        from: "pro",
        to: "enterprise",
        by: "platform_admin",
      })
    ).toBe("pro → enterprise · platform_admin");
  });

  /*
   * The decline vocabulary is stated once, in `decline-reasons`. Rendering the
   * raw enum here would put `schedule_conflict` on screen beside the same
   * reason spelled properly on My Tasks and on the dashboard.
   */
  it("spells a decline reason the way the rest of the product does", () => {
    const text = summariseAudit(ACTIONS.ASSIGNMENT_REJECTED, {
      taskTitle: "Lunch Service",
      reason: "schedule_conflict",
    });

    expect(text).toContain('"Lunch Service"');
    expect(text).not.toContain("schedule_conflict");
  });

  /*
   * Deactivating releases future shifts. The count is the consequence, and a
   * row recording only the act answers half the question somebody is asking
   * when they open this screen.
   */
  it("reports what a deactivation cost", () => {
    expect(
      summariseAudit(ACTIONS.MEMBER_DEACTIVATED, {
        previousStatus: "active",
        newStatus: "inactive",
        releasedShifts: 3,
      })
    ).toBe("active → inactive · 3 shifts released");
  });

  it("says nothing extra when there is nothing extra", () => {
    expect(summariseAudit(ACTIONS.AVAILABILITY_REVIEW_REQUESTED, {})).toBeNull();
  });
});

describe("task.assigned has two writers", () => {
  /*
   * `assignStaff` records the ids it was handed; the weekly scheduler records
   * counts across a whole run. Both write `task.assigned`, and a summariser
   * that knew only one shape rendered a blank cell for every automatic run —
   * the rows a company admin most wants to read.
   */
  it("counts the people a manager assigned", () => {
    const text = summariseAudit(ACTIONS.TASK_ASSIGNED, {
      taskTitle: "Evening Service",
      membershipIds: ["a", "b"],
      status: "pending",
    });

    expect(text).toContain('"Evening Service"');
    expect(text).toContain("2 people");
  });

  it("reports what a scheduling run managed to fill", () => {
    expect(
      summariseAudit(ACTIONS.TASK_ASSIGNED, {
        assignmentsCreated: 7,
        totalPlanned: 10,
        allocationProvider: "groq",
      })
    ).toBe("7 of 10 placed · via groq");
  });

  it("says one person, not one people", () => {
    expect(
      summariseAudit(ACTIONS.TASK_ASSIGNED, { membershipIds: ["a"] })
    ).toContain("1 person");
  });
});

describe("rows for actions the catalogue has retired", () => {
  /*
   * `member.role_changed` predates the custom-role split, and its rows are
   * still in the table. An unrecognised action is an old row, not an error —
   * the page falls back to showing the action itself, and this must not throw
   * on the way there.
   */
  it("answers null instead of throwing", () => {
    expect(summariseAudit("some.retired_action", { name: "x" })).toBeNull();
  });
});

describe("the report export names its scope", () => {
  /*
   * The one action that records an EXTRACTION rather than a change. The same
   * button produces one department's figures for a manager and the whole
   * company's for an admin, and this row is the only record of which left the
   * building.
   */
  it("distinguishes an org-wide export from a scoped one", () => {
    expect(summariseAudit(ACTIONS.REPORT_EXPORTED, { scope: "org-wide" })).toContain(
      "org-wide"
    );
    expect(
      summariseAudit(ACTIONS.REPORT_EXPORTED, { scope: ["d1", "d2"] })
    ).toContain("2 departments");
  });
});
