// @vitest-environment jsdom
/**
 * My Tasks after the split with My History.
 *
 * This page used to end with a "Finished" panel: the last three completed and
 * declined shifts behind a "show all" toggle. It was a second, smaller
 * implementation of the record — on the one screen in the product read standing
 * up, on a phone, to answer "am I on tonight". Finished work is noise against
 * that question, and the toggle made the "34 left to rate" tile on My History
 * point at a screen that would show three of them.
 *
 * So what is pinned here is a boundary rather than a feature: which rows this
 * page claims, which it has handed over, and that a member with nothing
 * outstanding is told that rather than being told they have never been given a
 * shift.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MyTasksPage from "@/app/(app)/org/[orgId]/my-tasks/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "pending",
    clockInTime: null,
    clockOutTime: null,
    rejectionReason: null,
    rejectionNotes: null,
    withdrawalReason: null,
    withdrawalNotes: null,
    satisfactionRating: null,
    satisfactionComment: null,
    task: {
      id: "t1",
      title: "Tonight's close",
      description: null,
      priority: "medium",
      scheduledStart: "2026-08-20T10:00:00.000Z",
      scheduledEnd: "2026-08-20T14:00:00.000Z",
      department: { name: "Kitchen" },
      createdBy: { name: "Sarah" },
    },
    assignedBy: { name: "Sarah" },
    ...overrides,
  };
}

function mockApi(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(rows) } as Response)
    )
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what this page still claims", () => {
  it("shows a shift waiting on an answer", async () => {
    mockApi([assignment()]);
    render(<MyTasksPage />);

    expect(await screen.findByText("Tonight's close")).toBeInTheDocument();
  });

  it("shows an accepted shift", async () => {
    mockApi([assignment({ status: "accepted" })]);
    render(<MyTasksPage />);

    expect(await screen.findByText("Tonight's close")).toBeInTheDocument();
  });

  /*
   * Clocked out but not marked complete is an outstanding ACTION, so it stays —
   * even though the shift itself is over and also appears in My History. The
   * same row legitimately answers two questions: "what do I still have to do"
   * and "what happened".
   */
  it("keeps a clocked-out shift that still needs marking complete", async () => {
    mockApi([assignment({ status: "clocked_out", clockInTime: "2026-08-20T10:00:00.000Z", clockOutTime: "2026-08-20T14:00:00.000Z" })]);
    render(<MyTasksPage />);

    expect(await screen.findByText("Tonight's close")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark as complete/i })).toBeInTheDocument();
  });

  // Awaiting a manager's decision is live work, not history — the member is
  // still rostered and the outcome is undecided.
  it("keeps a decline that is still with a manager", async () => {
    mockApi([assignment({ status: "decline_requested" })]);
    render(<MyTasksPage />);

    expect(await screen.findByText("Tonight's close")).toBeInTheDocument();
  });

  it("keeps a withdrawal that is still with a manager", async () => {
    mockApi([assignment({ status: "withdrawal_requested", withdrawalReason: "transport_issues" })]);
    render(<MyTasksPage />);

    expect(await screen.findByText("Tonight's close")).toBeInTheDocument();
  });
});

describe("what it has handed to My History", () => {
  it("does not show a completed shift", async () => {
    mockApi([assignment({ status: "completed" })]);
    render(<MyTasksPage />);

    await screen.findByText(/Nothing on your plate/i);
    expect(screen.queryByText("Tonight's close")).not.toBeInTheDocument();
  });

  it("does not show a declined shift", async () => {
    mockApi([assignment({ status: "rejected", rejectionReason: "feeling_unwell" })]);
    render(<MyTasksPage />);

    await screen.findByText(/Nothing on your plate/i);
    expect(screen.queryByText("Tonight's close")).not.toBeInTheDocument();
  });

  it("does not show a shift withdrawn from", async () => {
    mockApi([assignment({ status: "withdrawn" })]);
    render(<MyTasksPage />);

    await screen.findByText(/Nothing on your plate/i);
    expect(screen.queryByText("Tonight's close")).not.toBeInTheDocument();
  });

  /*
   * Rating moved with the finished shifts. Leaving the control here as well
   * would put the same decision in two places, and the "left to rate" tile can
   * only point at one of them.
   */
  it("does not offer the rating control", async () => {
    mockApi([
      assignment({
        status: "clocked_out",
        clockInTime: "2026-08-20T10:00:00.000Z",
        clockOutTime: "2026-08-20T14:00:00.000Z",
      }),
    ]);
    render(<MyTasksPage />);

    await screen.findByText("Tonight's close");
    expect(screen.queryByRole("radio", { name: /out of 5/i })).not.toBeInTheDocument();
  });

  // The only route to the record from here, now that this page carries none.
  it("links to My History", async () => {
    mockApi([assignment()]);
    render(<MyTasksPage />);

    const link = await screen.findByRole("link", { name: /finished with/i });
    expect(link).toHaveAttribute("href", "/org/org1/my-history");
  });
});

describe("searching what is on the plate", () => {
  /** Five live shifts, since the box only appears once there is enough to sift. */
  function many() {
    return [
      assignment({ id: "a1", task: { ...assignment().task, title: "Saturday close", department: { name: "Kitchen" } } }),
      assignment({ id: "a2", task: { ...assignment().task, title: "Sunday brunch", department: { name: "Kitchen" } } }),
      assignment({ id: "a3", task: { ...assignment().task, title: "Friday bar", department: { name: "Bar" } } }),
      assignment({ id: "a4", task: { ...assignment().task, title: "Monday prep", department: { name: "Kitchen" } } }),
      assignment({ id: "a5", task: { ...assignment().task, title: "Tuesday close", department: { name: "Bar" } } }),
    ];
  }

  /*
   * A member with two shifts does not need a search box, and an empty one on a
   * phone costs a row of screen for nothing.
   */
  it("stays hidden until there is enough to sift", async () => {
    mockApi([assignment()]);
    render(<MyTasksPage />);

    await screen.findByText("Tonight's close");
    expect(screen.queryByLabelText("Search your shifts")).not.toBeInTheDocument();
  });

  it("appears once there is", async () => {
    mockApi(many());
    render(<MyTasksPage />);

    expect(await screen.findByLabelText("Search your shifts")).toBeInTheDocument();
  });

  it("narrows to matching shift names", async () => {
    mockApi(many());
    render(<MyTasksPage />);
    await screen.findByText("Saturday close");

    await userEvent.type(screen.getByLabelText("Search your shifts"), "brunch");

    expect(screen.getByText("Sunday brunch")).toBeInTheDocument();
    expect(screen.queryByText("Saturday close")).not.toBeInTheDocument();
  });

  /*
   * Department as well as title. "What am I on in the bar this week" is as
   * likely a question as "when was that close shift".
   */
  it("matches on department too", async () => {
    mockApi(many());
    render(<MyTasksPage />);
    await screen.findByText("Friday bar");

    await userEvent.type(screen.getByLabelText("Search your shifts"), "bar");

    expect(screen.getByText("Friday bar")).toBeInTheDocument();
    expect(screen.queryByText("Sunday brunch")).not.toBeInTheDocument();
  });

  it("ignores case", async () => {
    mockApi(many());
    render(<MyTasksPage />);
    await screen.findByText("Saturday close");

    await userEvent.type(screen.getByLabelText("Search your shifts"), "SATURDAY");

    expect(screen.getByText("Saturday close")).toBeInTheDocument();
  });

  /*
   * The tiles count what is outstanding; the panels show what matched. If the
   * tiles followed the search, typing a word would make "5 to respond" read
   * "1", and a member could believe four shifts had gone away.
   */
  it("leaves the tiles counting everything", async () => {
    mockApi(many());
    render(<MyTasksPage />);
    await screen.findByText("Saturday close");

    const tile = screen.getByText("To respond").closest("div")!;
    expect(within(tile).getByText("5")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Search your shifts"), "brunch");

    expect(within(tile).getByText("5")).toBeInTheDocument();
  });

  // Nothing matched is a claim about the search; nothing outstanding is a claim
  // about their week.
  it("says nothing matched rather than nothing to do", async () => {
    mockApi(many());
    render(<MyTasksPage />);
    await screen.findByText("Saturday close");

    await userEvent.type(screen.getByLabelText("Search your shifts"), "zzzz");

    expect(screen.getByText(/Nothing matches/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing on your plate/i)).not.toBeInTheDocument();
  });
});

describe("an empty plate", () => {
  /*
   * Two different empty states, and the distinction is the point. Someone with
   * forty finished shifts and nothing outstanding has an empty plate; the old
   * check keyed on every row the endpoint returned, so it would have told them
   * "no tasks assigned to you yet" — a claim about their whole history rather
   * than about today.
   */
  it("tells a member with finished work where it went", async () => {
    mockApi([assignment({ status: "completed" })]);
    render(<MyTasksPage />);

    expect(await screen.findByText(/in My History/i)).toBeInTheDocument();
  });

  it("tells a genuinely new member something different", async () => {
    mockApi([]);
    render(<MyTasksPage />);

    expect(await screen.findByText(/When a manager assigns you a shift/i)).toBeInTheDocument();
    expect(screen.queryByText(/in My History/i)).not.toBeInTheDocument();
  });
});
