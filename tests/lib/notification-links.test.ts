/**
 * Where a notification takes you, and — the point of the file — whether the
 * person reading it can open the page it chose.
 *
 * ## The bug
 *
 * Seven staff-facing types pushed to `/tasks`: a shift cancelled, a shift
 * rescheduled, being removed from one, and the four decline and withdrawal
 * outcomes. `/tasks` renders "You don't have access to Tasks" for anybody
 * without `TASK_LIST_READERS`. So a staff member was told something had
 * happened to their shift, tapped it, and hit a lock screen.
 *
 * The identical fix already existed ten lines away for certificates, with a
 * comment explaining the problem, and had never been applied to tasks.
 *
 * Four more types — everything about leave — had no case in either switch and
 * did nothing at all when clicked.
 */
import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_DESTINATIONS,
  notificationHref,
} from "@/lib/notification-links";
import { NOTIFICATION_TYPE_LIST } from "@/lib/notification-types";
import {
  MEMBER_LIST_READERS,
  TASK_LIST_READERS,
} from "@/lib/permissions";

const ORG = "org1";

/** Somebody with no permissions at all — a plain staff member. */
const nobody = () => false;
/** A company admin, who holds the entire catalogue. */
const everything = () => true;
const holds = (...permissions: string[]) => (p: string) =>
  permissions.includes(p);

/**
 * The pages with NO permission gate, verified by reading each one:
 *
 *   /my-tasks, /my-certifications, /availability, /my-schedule — no gate
 *   /my-history — no client gate; its route refuses non-rosterable members,
 *                 which is an admin-only concern and not a permission
 *
 * Every fallback must be one of these, because a fallback exists precisely for
 * the reader who failed the permission check.
 */
const UNGATED = ["my-tasks", "my-history", "my-certifications", "availability"];

/**
 * The gated pages and the gate each one actually applies, read from the page:
 *
 *   /tasks   → canAny(TASK_LIST_READERS)          (tasks/page.tsx)
 *   /members → canAny(MEMBER_LIST_READERS)        (members/page.tsx)
 *   /leave   → can("members:request_availability") (leave/page.tsx)
 */
const GATES: Record<string, readonly string[]> = {
  tasks: TASK_LIST_READERS,
  members: MEMBER_LIST_READERS,
  leave: ["members:request_availability"],
};

function pageOf(href: string): string {
  return href.replace(`/org/${ORG}/`, "");
}

describe("every type knows where it goes", () => {
  it("has a destination for each one", () => {
    for (const type of NOTIFICATION_TYPE_LIST) {
      expect(notificationHref(type, ORG, everything), type).not.toBeNull();
    }
  });

  /*
   * Guessing a plausible page for an unrecognised type would be the original
   * bug in a new place — `/tasks` looks like a reasonable default and is the
   * one a staff member cannot open.
   */
  it("returns null for a type nobody defined", () => {
    expect(notificationHref("something_new", ORG, everything)).toBeNull();
  });
});

describe("nobody is sent to a page they cannot open", () => {
  /*
   * The test this file exists for.
   *
   * Asserted for EVERY type rather than the seven known to be broken: the
   * failure was one person forgetting to apply a known fix to a second place,
   * so a test naming only the places that were wrong would have caught nothing.
   */
  it("sends a member with no permissions only to ungated pages", () => {
    for (const type of NOTIFICATION_TYPE_LIST) {
      const page = pageOf(notificationHref(type, ORG, nobody)!);
      expect(UNGATED, `${type} sends a permissionless member to /${page}`).toContain(
        page
      );
    }
  });

  /*
   * And the destinations table cannot quietly acquire a gated fallback later.
   * The check above would still pass if a fallback pointed at `/tasks` and the
   * reader happened to hold the permission — this one reads the table itself.
   */
  it("declares no fallback that is gated", () => {
    for (const [type, destination] of Object.entries(NOTIFICATION_DESTINATIONS)) {
      expect(GATES[destination.fallback], `${type} falls back to a gated page`)
        .toBeUndefined();
    }
  });

  /*
   * `requires` has to name the permissions the destination page ACTUALLY
   * checks. A preferred page whose declared permissions do not match its own
   * gate would send a reader who holds the wrong ones straight into the lock
   * screen — the same failure, arrived at by a different route.
   */
  it("declares the permissions each preferred page really checks", () => {
    for (const [type, destination] of Object.entries(NOTIFICATION_DESTINATIONS)) {
      const gate = GATES[destination.preferred];
      if (!gate) {
        expect(destination.requires, `${type} guards an ungated page`).toEqual([]);
        continue;
      }
      expect([...destination.requires].sort(), `${type} → /${destination.preferred}`)
        .toEqual([...gate].sort());
    }
  });
});

describe("the split between the two audiences", () => {
  /*
   * A shift cancellation is the case that was broken. The manager belongs on
   * the board; the member belongs on the list with the accept and decline
   * buttons, which the notification never used to reach.
   */
  it("sends a cancelled shift to the board for a manager and My Tasks for staff", () => {
    expect(notificationHref("task_cancelled", ORG, holds("tasks:assign"))).toBe(
      "/org/org1/tasks"
    );
    expect(notificationHref("task_cancelled", ORG, nobody)).toBe(
      "/org/org1/my-tasks"
    );
  });

  it("does the same for the decline and withdrawal outcomes", () => {
    for (const type of [
      "decline_approved",
      "decline_denied",
      "withdrawal_approved",
      "withdrawal_denied",
      "task_rescheduled",
      "task_unassigned",
    ]) {
      expect(notificationHref(type, ORG, nobody), type).toBe("/org/org1/my-tasks");
    }
  });

  /*
   * Finished work goes to My History rather than My Tasks. A completed shift
   * has already left the list of things to answer, so sending somebody there to
   * look for it would be sending them to an empty page.
   */
  it("sends finished work to My History", () => {
    expect(notificationHref("task_completed", ORG, nobody)).toBe(
      "/org/org1/my-history"
    );
    expect(notificationHref("shift_rated_low", ORG, nobody)).toBe(
      "/org/org1/my-history"
    );
  });

  it("sends an hour warning to the member list for a manager, own history for staff", () => {
    expect(notificationHref("hour_limit_warning", ORG, holds("members:invite"))).toBe(
      "/org/org1/members"
    );
    expect(notificationHref("hour_limit_warning", ORG, nobody)).toBe(
      "/org/org1/my-history"
    );
  });
});

describe("leave, which used to be unclickable entirely", () => {
  /*
   * All four carry `entityType: "availability"`, which is why neither switch
   * could route them: one page cannot serve both "somebody asked for leave"
   * (a job for the reviewer) and "your leave was approved" (news for the
   * member). Keying on the TYPE is what makes the distinction expressible.
   */
  it("sends a request to the approvals queue for whoever reviews leave", () => {
    expect(
      notificationHref("leave_requested", ORG, holds("members:request_availability"))
    ).toBe("/org/org1/leave");
  });

  it("sends the same request to availability for anybody who cannot review", () => {
    expect(notificationHref("leave_requested", ORG, nobody)).toBe(
      "/org/org1/availability"
    );
  });

  it("sends an outcome to the member's own availability", () => {
    for (const type of [
      "leave_approved",
      "leave_rejected",
      "availability_review_requested",
    ]) {
      expect(notificationHref(type, ORG, nobody), type).toBe(
        "/org/org1/availability"
      );
    }
  });
});

describe("certificates", () => {
  /*
   * All three go to the HOLDER, so the review queue would be the wrong page
   * even for a manager who can open it — theirs is the certificate that was
   * submitted. This is the one case that was already right, kept pinned so a
   * later tidy-up does not "fix" it into consistency with the others.
   */
  it("always goes to the holder's own list, whatever they may do", () => {
    for (const type of ["cert_verified", "cert_rejected", "cert_expiring"]) {
      expect(notificationHref(type, ORG, everything), type).toBe(
        "/org/org1/my-certifications"
      );
      expect(notificationHref(type, ORG, nobody), type).toBe(
        "/org/org1/my-certifications"
      );
    }
  });
});
