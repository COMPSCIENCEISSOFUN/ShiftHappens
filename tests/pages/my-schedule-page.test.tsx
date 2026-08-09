// @vitest-environment jsdom
/**
 * My Schedule — the member's own week.
 *
 * What is worth pinning here is not the geometry, which `calendar-grid` already
 * owns and tests, but the three decisions this page makes on top of it:
 *
 *   - it reads the member-scoped endpoint and not the organisation task board,
 *     which is a permission boundary and not a preference;
 *   - a shift the member turned down is not on their calendar, while one they
 *     have merely ASKED to leave still is, because they are still rostered
 *     until a manager decides;
 *   - a member with no shifts at all is told that, rather than shown an empty
 *     grid to click backwards through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import MySchedulePage from "@/app/(app)/org/[orgId]/my-schedule/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

/** Midday to midday-plus-four, on a date inside the current week. */
function shiftTimes(dayOffset = 0) {
  const start = new Date();
  const monday = new Date(start);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() + dayOffset);
  const end = new Date(monday.getTime() + 4 * 60 * 60 * 1000);
  return { scheduledStart: monday.toISOString(), scheduledEnd: end.toISOString() };
}

function assignment(overrides: Record<string, unknown> = {}) {
  const { task, ...rest } = overrides as { task?: Record<string, unknown> };
  return {
    id: "a1",
    status: "accepted",
    task: {
      id: "t1",
      title: "Dinner service",
      department: { name: "Kitchen" },
      ...shiftTimes(),
      ...(task ?? {}),
    },
    ...rest,
  };
}

let requested: string[] = [];

function mockApi(assignments: unknown[], displayOk = true) {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      requested.push(String(url));
      if (String(url).includes("/settings/display")) {
        return Promise.resolve({
          ok: displayOk,
          status: displayOk ? 200 : 403,
          json: () =>
            Promise.resolve(
              displayOk
                ? { operatingHoursStart: 6, operatingHoursEnd: 22 }
                : { error: "Forbidden" }
            ),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(assignments),
      } as Response);
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("where the shifts come from", () => {
  /*
   * The one that matters. `GET /tasks` requires TASK_LIST_READERS because a
   * plain member typing that URL used to receive the whole organisation's task
   * board — so populating a personal screen from it would trade a permission
   * boundary for a convenience.
   */
  it("reads the member's own endpoint, never the organisation task list", async () => {
    mockApi([assignment()]);
    render(<MySchedulePage />);

    await screen.findAllByText("Dinner service");

    expect(requested.some((u) => u.includes("/my-tasks"))).toBe(true);
    expect(
      requested.some((u) => /\/tasks(\?|$)/.test(u)),
      "must not read the org-wide task board"
    ).toBe(false);
  });

  /*
   * Operating hours are a nicety. The member-scoped display route exists
   * because the admin-only settings GET answered 403 to everyone else and the
   * team calendar silently kept a hard-coded 6am–10pm — but if it fails, the
   * grid still has to show every shift, because `gridHoursFor` grows to cover
   * whatever is scheduled regardless of the window.
   */
  it("still draws the week when the display settings are refused", async () => {
    mockApi([assignment()], false);
    render(<MySchedulePage />);

    expect(await screen.findAllByText("Dinner service")).not.toHaveLength(0);
  });
});

describe("which of the member's shifts appear", () => {
  it("shows a shift they have accepted", async () => {
    mockApi([assignment({ status: "accepted" })]);
    render(<MySchedulePage />);

    expect(await screen.findAllByText("Dinner service")).not.toHaveLength(0);
  });

  it("shows one still waiting for their answer", async () => {
    mockApi([assignment({ status: "pending" })]);
    render(<MySchedulePage />);

    expect(await screen.findAllByText("Dinner service")).not.toHaveLength(0);
  });

  /*
   * Turned down, so not theirs. `occupiesSlot` is the shared rule — only
   * `rejected` and `withdrawn` give the slot back — and using it here rather
   * than a status list written in the page is the whole reason that module
   * exists.
   */
  it("does not show one they rejected", async () => {
    mockApi([assignment({ status: "rejected" })]);
    render(<MySchedulePage />);

    expect(await screen.findByText("No shifts yet")).toBeInTheDocument();
    expect(screen.queryByText("Dinner service")).not.toBeInTheDocument();
  });

  it("does not show one an approved withdrawal removed them from", async () => {
    mockApi([assignment({ status: "withdrawn" })]);
    render(<MySchedulePage />);

    expect(await screen.findByText("No shifts yet")).toBeInTheDocument();
  });

  /*
   * Asked to leave, not yet released. The member is still rostered until a
   * manager decides, and a shift vanishing the moment they ask to drop it would
   * tell them they are off when they are not — the same reason the status
   * occupies a slot everywhere else.
   */
  it("still shows one they have asked to withdraw from", async () => {
    mockApi([assignment({ status: "withdrawal_requested" })]);
    render(<MySchedulePage />);

    expect(await screen.findAllByText("Dinner service")).not.toHaveLength(0);
  });

  it("still shows a full-timer's pending decline", async () => {
    mockApi([assignment({ status: "decline_requested" })]);
    render(<MySchedulePage />);

    expect(await screen.findAllByText("Dinner service")).not.toHaveLength(0);
  });

  /*
   * A shift with no times cannot be placed on a grid. Dropping it silently is
   * correct here — My Tasks lists it, and inventing a position would put it at
   * an hour nobody scheduled.
   */
  it("leaves out a shift with no scheduled time", async () => {
    mockApi([
      assignment({ task: { scheduledStart: null, scheduledEnd: null } }),
    ]);
    render(<MySchedulePage />);

    expect(await screen.findByText("No shifts yet")).toBeInTheDocument();
  });
});

describe("the empty state", () => {
  /*
   * "Nothing at all" is a different fact from "nothing this week", and the
   * second invites clicking backwards through empty weeks looking for shifts
   * that were never there.
   */
  it("says there are no shifts yet rather than showing a blank grid", async () => {
    mockApi([]);
    render(<MySchedulePage />);

    expect(await screen.findByText("No shifts yet")).toBeInTheDocument();
  });
});

describe("the week summary", () => {
  it("counts the shifts and their hours", async () => {
    mockApi([
      assignment({ id: "a1", task: { id: "t1", ...shiftTimes(0) } }),
      assignment({ id: "a2", task: { id: "t2", ...shiftTimes(1) } }),
    ]);
    render(<MySchedulePage />);

    // Two four-hour shifts inside the current week.
    expect(await screen.findByText(/2 shifts/)).toBeInTheDocument();
    expect(screen.getByText(/8h/)).toBeInTheDocument();
  });

  // Singular, because "1 shifts" in a member-facing summary reads as a bug.
  it("says one shift, not one shifts", async () => {
    mockApi([assignment()]);
    render(<MySchedulePage />);

    expect(await screen.findByText(/1 shift(?!s)/)).toBeInTheDocument();
  });
});
